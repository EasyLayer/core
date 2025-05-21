import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ArithmeticService } from '../arithmetic.service';

describe('ArithmeticService', () => {
  let service: ArithmeticService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ArithmeticService],
    }).compile();

    service = module.get<ArithmeticService>(ArithmeticService);
  });

  describe('add', () => {
    it('should add two numbers correctly', () => {
      expect(service.add(1, 2)).toBe(BigInt(3));
      expect(service.add('1', '2')).toBe(BigInt(3));
      expect(service.add(BigInt(1), BigInt(2))).toBe(BigInt(3));
    });

    it('should add number and string correctly', () => {
      expect(service.add(1, '2')).toBe(BigInt(3));
    });

    it('should add number and bigint correctly', () => {
      expect(service.add(1, BigInt(2))).toBe(BigInt(3));
    });

    it('should add string and bigint correctly', () => {
      expect(service.add('1', BigInt(2))).toBe(BigInt(3));
    });
  });

  describe('subtract', () => {
    it('should subtract two numbers correctly', () => {
      expect(service.subtract(3, 2)).toBe(BigInt(1));
      expect(service.subtract('3', '2')).toBe(BigInt(1));
      expect(service.subtract(BigInt(3), BigInt(2))).toBe(BigInt(1));
    });

    it('should subtract number and string correctly', () => {
      expect(service.subtract(3, '2')).toBe(BigInt(1));
    });

    it('should subtract number and bigint correctly', () => {
      expect(service.subtract(3, BigInt(2))).toBe(BigInt(1));
    });

    it('should subtract string and bigint correctly', () => {
      expect(service.subtract('3', BigInt(2))).toBe(BigInt(1));
    });
  });

  describe('multiply', () => {
    it('should multiply two numbers correctly', () => {
      expect(service.multiply(2, 3)).toBe(BigInt(6));
      expect(service.multiply('2', '3')).toBe(BigInt(6));
      expect(service.multiply(BigInt(2), BigInt(3))).toBe(BigInt(6));
    });

    it('should multiply number and string correctly', () => {
      expect(service.multiply(2, '3')).toBe(BigInt(6));
    });

    it('should multiply number and bigint correctly', () => {
      expect(service.multiply(2, BigInt(3))).toBe(BigInt(6));
    });

    it('should multiply string and bigint correctly', () => {
      expect(service.multiply('2', BigInt(3))).toBe(BigInt(6));
    });
  });

  describe('divide', () => {
    it('should divide two numbers correctly', () => {
      expect(service.divide(6, 3)).toBe(BigInt(2));
      expect(service.divide('6', '3')).toBe(BigInt(2));
      expect(service.divide(BigInt(6), BigInt(3))).toBe(BigInt(2));
    });

    it('should divide number and string correctly', () => {
      expect(service.divide(6, '3')).toBe(BigInt(2));
    });

    it('should divide number and bigint correctly', () => {
      expect(service.divide(6, BigInt(3))).toBe(BigInt(2));
    });

    it('should divide string and bigint correctly', () => {
      expect(service.divide('6', BigInt(3))).toBe(BigInt(2));
    });

    it('should throw error when dividing by zero', () => {
      expect(() => service.divide(6, 0)).toThrow('Division by zero is not allowed.');
      expect(() => service.divide('6', '0')).toThrow('Division by zero is not allowed.');
      expect(() => service.divide(BigInt(6), BigInt(0))).toThrow('Division by zero is not allowed.');
    });
  });
});
