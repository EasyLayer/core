import BigNumber from 'bignumber.js';

export interface Currency {
  code: string;
  minorUnit: number;
}

export interface FormatOptions {
  minFractionDigits?: number;
  maxFractionDigits?: number;
  removeTrailingFractionalZeros?: boolean;
  decimalSeparator?: string;
  groupSeparator?: string;
  groupSize?: number;
  secondaryGroupSize?: number;
  fractionGroupSeparator?: string;
  fractionGroupSize?: number;
}

interface MoneyJSON {
  amount: string;
  currency: Currency;
}

const assertSameCurrency = (a: Money, b: Money): void => {
  if (a.currency.code !== b.currency.code) {
    throw new Error('Different currencies');
  }
};

export const defaultFormatOptions: Required<FormatOptions> = {
  minFractionDigits: 2,
  maxFractionDigits: 20,
  removeTrailingFractionalZeros: true,
  decimalSeparator: '.',
  groupSeparator: ',',
  groupSize: 3,
  secondaryGroupSize: 0,
  fractionGroupSeparator: ' ',
  fractionGroupSize: 0,
};

export class Money {
  amount: BigNumber;
  currency: Currency;

  constructor(amount: BigNumber, currency: Currency) {
    this.amount = amount;
    this.currency = currency;
  }

  static fromCents(cents: string, currency: Currency): Money {
    return new Money(new BigNumber(cents).dividedBy(new BigNumber(`1e${currency.minorUnit}`)), currency);
  }

  static fromDecimal(amount: string, currency: Currency): Money {
    return new Money(new BigNumber(amount), currency);
  }

  toString(): string {
    return this.amount.toFixed();
  }

  toJSON(): MoneyJSON {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toCents(): string {
    return this.amount.multipliedBy(new BigNumber(`1e${this.currency.minorUnit}`)).toFixed(0);
  }

  convert(rate: string, toCurrency: Currency): Money {
    return new Money(this.amount.multipliedBy(new BigNumber(rate)), toCurrency);
  }

  add(money: Money): Money {
    assertSameCurrency(this, money);
    return new Money(this.amount.plus(money.amount), this.currency);
  }

  subtract(money: Money): Money {
    assertSameCurrency(this, money);
    return new Money(this.amount.minus(money.amount), this.currency);
  }

  multiply(multiplier: string): Money {
    return new Money(this.amount.multipliedBy(new BigNumber(multiplier)), this.currency);
  }

  divide(divisor: string): Money {
    return new Money(this.amount.dividedBy(new BigNumber(divisor)), this.currency);
  }

  compare(money: Money): number {
    assertSameCurrency(this, money);
    return this.amount.comparedTo(money.amount);
  }

  equals(money: Money): boolean {
    return this.compare(money) === 0;
  }

  greaterThan(money: Money): boolean {
    return this.compare(money) > 0;
  }

  greaterThanOrEqual(money: Money): boolean {
    return this.compare(money) >= 0;
  }

  lessThan(money: Money): boolean {
    return this.compare(money) < 0;
  }

  lessThanOrEqual(money: Money): boolean {
    return this.compare(money) <= 0;
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive();
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }
}
