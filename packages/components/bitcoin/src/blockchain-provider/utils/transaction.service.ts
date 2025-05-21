import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
import { KeyManagementService } from './key-management.service';

@Injectable()
export class TransactionService {
  constructor(private readonly keyManagementService: KeyManagementService) {}

  // PSBT (Partially Signed Bitcoin Transaction)
  public createPsbt(network: bitcoin.Network): bitcoin.Psbt {
    return new bitcoin.Psbt({ network });
  }

  public addInput(psbt: bitcoin.Psbt, input: bitcoin.PsbtTxInput) {
    // sequence: 0xFFFFFFFD - RBF supported input
    psbt.addInput(input);
  }

  public addOutput(psbt: bitcoin.Psbt, output: bitcoin.PsbtTxOutput) {
    psbt.addOutput(output);
  }

  public async signTransaction(psbt: bitcoin.Psbt, privateKey: string) {
    const keyPair = await this.keyManagementService.keyPairFromPrivateKey(privateKey);
    psbt.signAllInputs(keyPair);
  }

  public async verifySignatures(psbt: bitcoin.Psbt): Promise<boolean> {
    try {
      return this.keyManagementService.verifySignatures(psbt);
    } catch (error) {
      return false;
    }
  }

  public calculateFee(psbt: bitcoin.Psbt, feeRate: number): number {
    const txVirtualSize = psbt.extractTransaction().virtualSize();
    return txVirtualSize * feeRate;
  }

  public combinePsbt(psbts: bitcoin.Psbt[]): bitcoin.Psbt {
    const combinedPsbt = psbts[0];
    for (let i = 1; i < psbts.length; i++) {
      combinedPsbt?.combine(psbts[i]!);
    }
    return combinedPsbt!;
  }

  public finalizePsbt(psbt: bitcoin.Psbt): bitcoin.Transaction {
    psbt.finalizeAllInputs();
    return psbt.extractTransaction();
  }
}
