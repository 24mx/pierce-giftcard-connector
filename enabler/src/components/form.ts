import {
  Amount,
  BalanceType,
  BaseOptions,
  GiftCardComponent,
  GiftCardOptions,
  PaymentResult,
} from '../providers/definitions';
import { BaseComponentBuilder, DefaultComponent } from './definitions';
import {
  addFormFieldsEventListeners,
  fieldIds,
  getErrorCode,
  getInput,
  handleEnter,
  hideError,
  showError,
} from './utils';
import inputFieldStyles from '../style/inputField.module.scss';
import I18n from '../i18n';
import { translations } from '../i18n/translations';

export class FormBuilder extends BaseComponentBuilder {
  constructor(baseOptions: BaseOptions) {
    super(baseOptions);
  }

  build(config: GiftCardOptions): GiftCardComponent {
    return new FormComponent({
      giftcardOptions: config,
      baseOptions: this.baseOptions,
    });
  }
}

export class FormComponent extends DefaultComponent {
  protected i18n: I18n;

  constructor(opts: { giftcardOptions: GiftCardOptions; baseOptions: BaseOptions }) {
    super(opts);
    this.i18n = new I18n(translations);
    this.balance = this.balance.bind(this);
    this.submit = this.submit.bind(this);
  }

  async balance(): Promise<BalanceType> {
    try {
      const giftCardCode = getInput(fieldIds.code).value.replace(/\s/g, '');
      const requestBody = {
        code: giftCardCode,
      };
      const fetchBalanceURL = this.baseOptions.processorUrl.endsWith('/')
        ? `${this.baseOptions.processorUrl}balance`
        : `${this.baseOptions.processorUrl}/balance`;
      const response = await fetch(fetchBalanceURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': this.baseOptions.sessionId,
        },
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await response.json();
      if (!jsonResponse?.status?.state) {
        throw jsonResponse;
      }

      const errorCode = getErrorCode(jsonResponse);
      if (errorCode) {
        const translatedMessage = this.i18n.keyExists(`error${errorCode}`, this.baseOptions.locale)
          ? this.i18n.translate(`error${errorCode}`, this.baseOptions.locale)
          : this.i18n.translate('errorGenericError', this.baseOptions.locale);
        showError(fieldIds.code, translatedMessage);
      } else {
        hideError(fieldIds.code);
      }

      return jsonResponse;
    } catch (err) {
      showError(fieldIds.code, this.i18n.translate('errorGenericError', this.baseOptions.locale));
      this.baseOptions.onError(err);
    }
  }

  async submit(params: { amount?: Amount }): Promise<void> {
    try {
      const giftCardCode = getInput(fieldIds.code).value.replace(/\s/g, '');
      const requestBody = {
        redeemAmount: params.amount,
        code: giftCardCode,
      };
      const requestRedeemURL = this.baseOptions.processorUrl.endsWith('/')
        ? `${this.baseOptions.processorUrl}redeem`
        : `${this.baseOptions.processorUrl}/redeem`;

      const response = await fetch(requestRedeemURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': this.baseOptions.sessionId,
        },
        body: JSON.stringify(requestBody),
      });

      const redeemResult = await response.json();

      if (!response.ok) {
        throw redeemResult;
      }

      const paymentResult: PaymentResult = {
        isSuccess: redeemResult.result,
        paymentReference: redeemResult.paymentReference,
      };

      this.baseOptions.onComplete(paymentResult);
    } catch (err) {
      this.baseOptions.onError(err);
    }
    return;
  }

  mount(selector: string): void {
    document.querySelector(selector).insertAdjacentHTML('afterbegin', this._getField());
    addFormFieldsEventListeners(this.giftcardOptions);
    handleEnter(fieldIds.code, this.balance);

    this.giftcardOptions
      ?.onGiftCardReady?.()
      .then()
      .catch((err) => {
        this.baseOptions.onError(err);
        throw err;
      });
  }

  private _getField() {
    return `
        <div class="${inputFieldStyles.wrapper}">
          <div class="${inputFieldStyles.paymentForm}">
            <div class="${inputFieldStyles.inputContainer}">
              <label class="${inputFieldStyles.inputLabel}" for="giftcard-code">
                ${this.i18n.translate('giftCardPlaceholder', this.baseOptions.locale)} <span aria-hidden="true"> *</span>
              </label>
              <input 
                class="${inputFieldStyles.inputField}" 
                type="text" 
                id="giftcard-code" 
                name="giftCardCode" 
                value=""
                aria-describedby="giftcard-code-error"
                aria-invalid="false"
              >
              <div 
                id="giftcard-code-error" 
                class="${inputFieldStyles.errorField}" 
                role="alert"
                aria-live="polite"
                aria-hidden="true"
              ></div>
          </div>
        </div>
      `;
  }
}
