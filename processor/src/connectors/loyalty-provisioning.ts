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

export type ProvisioningOptions = {
  typeKey: string;
  redemptionIdField: string;
  denominationsField: string;
  discountKeyPrefix: string;
  currencies: string[];
  sortOrderBase: string;
};

type Logger = { info(message: string): void };

/**
 * Idempotent set-up of everything the redemption needs in commercetools: the cart Type with the two
 * fields, and one absolute automatic CartDiscount per denomination, gated by
 * `custom.<denominationsField> contains "Dn"`. Re-running converges: missing fields are added to an
 * existing type (a field of the wrong type fails the run), and an existing discount has its value,
 * predicate, target, stacking mode and code requirement brought back in line. Discounts are never
 * deleted here - orders reference them.
 *
 * sortOrder: every CartDiscount in a project needs a distinct value in (0, 1), higher means applied
 * first. The denominations sit at `<base><two-digit index>` (0.00000101 … 0.00000118), far below any
 * marketing promotion, so percentages come off the full price and points off the promoted price.
 */
export async function provisionLoyaltyRedemption(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  logger: Logger,
): Promise<void> {
  await ensureCartType(client, opts, logger);
  const keys = denominationKeys();
  for (let index = 0; index < keys.length; index++) {
    await ensureDenominationDiscount(client, opts, keys[index], index, logger);
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
  denomination: string,
  index: number,
  logger: Logger,
): Promise<void> {
  const key = `${opts.discountKeyPrefix}${denomination}`;
  const cents = denominationMinorUnits(denomination);
  const value: CartDiscountValueAbsoluteDraft = {
    type: 'absolute',
    money: opts.currencies.map((currencyCode) => ({ currencyCode, centAmount: cents })),
  };
  const draft: CartDiscountDraft = {
    key,
    name: { en: `Loyalty points ${denomination}` },
    value,
    cartPredicate: `custom.${opts.denominationsField} contains "${denomination}"`,
    target: { type: 'totalPrice' },
    sortOrder: `${opts.sortOrderBase}${String(index + 1).padStart(2, '0')}`,
    isActive: true,
    requiresDiscountCode: false,
    stackingMode: 'Stacking',
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
