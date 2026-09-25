import {
  CartDiscount,
  CartDiscountDraft,
  CartDiscountUpdateAction,
  CartDiscountValueAbsoluteDraft,
  FieldDefinition,
  Type,
  TypeUpdateAction,
} from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { denominationKeys, denominationMinorUnits } from '../services/denominations';

export type ProvisioningStore = {
  storeKey: string;
  currency: string;
  levels: number;
};

export type ProvisioningOptions = {
  typeKey: string;
  redemptionIdField: string;
  denominationsField: string;
  discountKeyPrefix: string;
  stores: ProvisioningStore[];
  sortOrderBase: string;
};

type Logger = { info(message: string): void };

/**
 * Idempotent set-up of everything the redemption needs in commercetools: the cart Type with the two
 * fields, and one absolute automatic CartDiscount per denomination PER STORE, gated by
 * `custom.<denominationsField> contains "Dn"` and scoped to that store via `stores`. Store-scoping
 * keeps every store's set inside its OWN 100-active-automatic-discount budget instead of the
 * project-wide one, which a live check against pierce-prod found already at 90/100 from unrelated
 * marketing discounts. Each store gets exactly as many levels as its own currency needs to reach the
 * same real EUR-equivalent ceiling as every other store (see config.ts). Re-running converges: missing
 * fields are added to an existing type (a field of the wrong type fails the run), and an existing
 * discount has its value, predicate, target, stacking mode and code requirement brought back in line.
 * Discounts are never deleted here - orders reference them.
 *
 * sortOrder: commercetools enforces sortOrder uniqueness project-wide, not per-Store-scope. Every
 * CartDiscount needs a distinct value in (0, 1), and commercetools refuses a value ending in zero.
 * To guarantee uniqueness across all stores' discounts, the formula incorporates the store's position
 * in opts.stores: `<base><store-index><denomination-index>1` — e.g., store 0's 10th denomination
 * becomes `0.00000101101`, store 1's 10th denomination becomes `0.00000102101`.
 */
export async function provisionLoyaltyRedemption(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  logger: Logger,
): Promise<void> {
  await ensureCartType(client, opts, logger);
  for (let storeIndex = 0; storeIndex < opts.stores.length; storeIndex++) {
    const store = opts.stores[storeIndex];
    const keys = denominationKeys(store.levels);
    for (let index = 0; index < keys.length; index++) {
      await ensureDenominationDiscount(client, opts, store, keys[index], storeIndex, index, logger);
    }
  }
}

const fieldDefinitions = (opts: ProvisioningOptions): FieldDefinition[] => [
  {
    name: opts.redemptionIdField,
    label: { en: 'Loyalty redemption id' },
    required: false,
    type: { name: 'String' },
    inputHint: 'SingleLine',
  },
  {
    name: opts.denominationsField,
    label: { en: 'Loyalty discount denominations' },
    required: false,
    type: { name: 'Set', elementType: { name: 'String' } },
  },
];

async function ensureCartType(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  logger: Logger,
): Promise<void> {
  const existing = await getOr404<Type>(() => client.types().withKey({ key: opts.typeKey }).get().execute());
  const wanted = fieldDefinitions(opts);
  if (!existing) {
    await client
      .types()
      .post({
        body: {
          key: opts.typeKey,
          name: { en: 'Pierce loyalty redemption' },
          description: { en: 'Points redemption carried by the cart and copied onto the order' },
          resourceTypeIds: ['order'],
          fieldDefinitions: wanted,
        },
      })
      .execute();
    logger.info(`Created cart type ${opts.typeKey}`);
    return;
  }
  const present = new Map((existing.fieldDefinitions ?? []).map((definition) => [definition.name, definition]));
  for (const definition of wanted) {
    const found = present.get(definition.name);
    if (found && !sameFieldType(found, definition)) {
      // A field of the wrong type cannot be changed in place, and writing to it would fail every
      // redeem: better to stop the deployment here than to report a project that does not work.
      throw new Error(
        `Type ${opts.typeKey} already defines field ${definition.name} as ${describeFieldType(found)}, expected ${describeFieldType(definition)}`,
      );
    }
  }
  const actions: TypeUpdateAction[] = wanted
    .filter((definition) => !present.has(definition.name))
    .map((definition) => ({
      action: 'addFieldDefinition',
      fieldDefinition: {
        name: definition.name,
        label: definition.label,
        required: definition.required,
        type: definition.type,
      },
    }));
  if (actions.length === 0) {
    return;
  }
  await client
    .types()
    .withKey({ key: opts.typeKey })
    .post({ body: { version: existing.version, actions } })
    .execute();
  logger.info(`Added ${actions.length} field(s) to cart type ${opts.typeKey}`);
}

async function ensureDenominationDiscount(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  store: ProvisioningStore,
  denomination: string,
  storeIndex: number,
  index: number,
  logger: Logger,
): Promise<void> {
  const key = `${opts.discountKeyPrefix}${store.storeKey}-${denomination}`;
  const cents = denominationMinorUnits(denomination);
  const value: CartDiscountValueAbsoluteDraft = {
    type: 'absolute',
    money: [{ currencyCode: store.currency, centAmount: cents }],
  };
  const sortOrder = `${opts.sortOrderBase}${String(storeIndex + 1).padStart(2, '0')}${String(index + 1).padStart(2, '0')}1`;
  const draft: CartDiscountDraft = {
    key,
    name: { en: `Loyalty points ${store.storeKey} ${denomination}` },
    value,
    cartPredicate: `custom.${opts.denominationsField} contains "${denomination}"`,
    target: { type: 'totalPrice' },
    sortOrder,
    isActive: true,
    requiresDiscountCode: false,
    stackingMode: 'Stacking',
    stores: [{ typeId: 'store', key: store.storeKey }],
  };
  const existing = await getOr404<CartDiscount>(() => client.cartDiscounts().withKey({ key }).get().execute());
  if (!existing) {
    await client.cartDiscounts().post({ body: draft }).execute();
    logger.info(`Created cart discount ${key}`);
    return;
  }
  const actions: CartDiscountUpdateAction[] = [];
  if (!sameMoney(existing, value)) {
    actions.push({ action: 'changeValue', value });
  }
  if (existing.cartPredicate !== draft.cartPredicate) {
    actions.push({ action: 'changeCartPredicate', cartPredicate: draft.cartPredicate });
  }
  if (existing.target?.type !== 'totalPrice') {
    actions.push({ action: 'changeTarget', target: { type: 'totalPrice' } });
  }
  if (existing.stackingMode !== 'Stacking') {
    actions.push({ action: 'changeStackingMode', stackingMode: 'Stacking' });
  }
  if (existing.requiresDiscountCode) {
    actions.push({ action: 'changeRequiresDiscountCode', requiresDiscountCode: false });
  }
  if (!existing.isActive) {
    actions.push({ action: 'changeIsActive', isActive: true });
  }
  if (existing.sortOrder !== sortOrder) {
    actions.push({ action: 'changeSortOrder', sortOrder });
  }
  // A discount found by key but scoped to the wrong Store - or to no Store at all, which is what a
  // leftover from the pre-per-Store model looks like - would otherwise be reported as converged and
  // stay wrong forever, eating the project-wide automatic-discount budget and never firing for its
  // store's carts.
  if (!sameStores(existing, draft)) {
    actions.push({ action: 'setStores', stores: draft.stores ?? [] });
  }
  if (actions.length === 0) {
    return;
  }
  await client
    .cartDiscounts()
    .withKey({ key })
    .post({ body: { version: existing.version, actions } })
    .execute();
  logger.info(`Updated cart discount ${key}`);
}

const describeFieldType = (definition: FieldDefinition): string =>
  definition.type.name === 'Set' ? `Set<${definition.type.elementType.name}>` : definition.type.name;

const sameFieldType = (a: FieldDefinition, b: FieldDefinition): boolean =>
  describeFieldType(a) === describeFieldType(b);

const sameStores = (existing: CartDiscount, wanted: CartDiscountDraft): boolean => {
  // The API answers with key references; the draft may carry either a key or an id.
  const have = (existing.stores ?? []).map((s) => s.key).sort();
  const want = (wanted.stores ?? []).map((s) => s.key ?? s.id ?? '').sort();
  return have.length === want.length && have.every((entry, i) => entry === want[i]);
};

const sameMoney = (existing: CartDiscount, wanted: CartDiscountValueAbsoluteDraft): boolean => {
  if (existing.value.type !== 'absolute') {
    return false;
  }
  const have = existing.value.money.map((m) => `${m.currencyCode}:${m.centAmount}`).sort();
  const want = wanted.money.map((m) => `${m.currencyCode}:${m.centAmount}`).sort();
  return have.length === want.length && have.every((entry, i) => entry === want[i]);
};

async function getOr404<T>(call: () => Promise<{ body: T }>): Promise<T | null> {
  try {
    return (await call()).body;
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'statusCode' in e && (e as { statusCode: unknown }).statusCode === 404) {
      return null;
    }
    throw e;
  }
}
