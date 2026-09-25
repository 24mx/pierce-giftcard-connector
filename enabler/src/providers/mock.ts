import { FormBuilder } from '../components/form';
import { BaseOptions, EnablerOptions, GiftCardEnabler, GiftCardBuilder, RedemptionResult } from './definitions';

export class MockEnabler implements GiftCardEnabler {
  setupData: Promise<{ baseOptions: BaseOptions }>;

  constructor(options: EnablerOptions) {
    this.setupData = MockEnabler._Setup(options);
  }

  // Default handlers
  private static onError = (err: any) => {
    console.log(err);
    throw new Error('something went wrong.');
  };

  private static onComplete = (result: RedemptionResult) => {
    console.log('onSubmit', result);
  };

  private static _Setup = async (options: EnablerOptions): Promise<{ baseOptions: BaseOptions }> => {
    return {
      baseOptions: {
        sessionId: options.sessionId,
        processorUrl: options.processorUrl,
        locale: options.locale,
        onComplete: options.onComplete ? options.onComplete : this.onComplete,
        onError: options.onError ? options.onError : this.onError,
      },
    };
  };

  async createGiftCardBuilder(): Promise<GiftCardBuilder | never> {
    const setupData = await this.setupData;
    if (!setupData) {
      throw new Error('MockEnabler not initialized');
    }

    return new FormBuilder(setupData.baseOptions);
  }
}
