export interface GiftCardComponent {
  submit(opts: { amount?: Amount }): void;
  balance(): Promise<BalanceType>;
  mount(selector: string): void;
}

export type Amount = {
  centAmount: number;
  currencyCode: string;
};

export interface GiftCardBuilder {
  build(config: GiftCardOptions): GiftCardComponent;
}

export type GiftCardOptions = {
  onGiftCardReady?: () => Promise<void>;
  onValueChange?: (hasValue: boolean) => Promise<void>;
  onEnter?: () => Promise<void>;
};

export type BaseOptions = {
  sessionId: string;
  processorUrl: string;
  locale?: string;
  onComplete?: (result: RedemptionResult) => void;
  onError?: (error: any) => void;
};

export type BalanceType = {
  status: {
    state: 'Valid' | 'NotFound' | 'Expired' | 'CurrencyNotMatch' | 'GenericError';
    errors?: {
      code: string;
      message: string;
    };
  };
  amount?: {
    centAmount: number;
    currencyCode: string;
  };
};

export type EnablerOptions = {
  processorUrl: string;
  sessionId: string;
  locale?: string;
  onComplete?: (result: RedemptionResult) => void;
  onError?: (error: any) => void;
};

// What /redeem hands back on success: no Payment exists, the redemption lives on the cart's custom
// fields and is keyed by the redemptionId the processor minted (the id /finalize and /release take).
export type RedemptionResult =
  | {
      isSuccess: true;
      redemptionId: string;
      points: number;
      appliedAmount: Amount;
    }
  | { isSuccess: false };

export interface GiftCardEnabler {
  /**
   * @throws {Error}
   */
  createGiftCardBuilder: (type: string) => Promise<GiftCardBuilder | never>;
}
