import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
import { KeyManagementService } from './key-management.service';

@Injectable()
export class TransactionService {
  constructor(private readonly kms: KeyManagementService) {}

  createPsbt(network: bitcoin.Network): bitcoin.Psbt {
    return new bitcoin.Psbt({ network });
  }

  addInput(psbt: bitcoin.Psbt, input: bitcoin.PsbtTxInput) {
    psbt.addInput(input);
  }

  addOutput(psbt: bitcoin.Psbt, output: bitcoin.PsbtTxOutput) {
    psbt.addOutput(output);
  }

  async signTransaction(psbt: bitcoin.Psbt, privateKeyHex: string) {
    const keyPair = await this.kms.keyPairFromPrivateKey(privateKeyHex);
    psbt.signAllInputs(keyPair);
  }

  async verifySignatures(psbt: bitcoin.Psbt): Promise<boolean> {
    return this.kms.verifySignatures(psbt);
  }

  calculateFee(psbt: bitcoin.Psbt, feeRate: number): number {
    const vsize = psbt.extractTransaction().virtualSize();
    return vsize * feeRate;
  }

  combinePsbt(psbts: bitcoin.Psbt[]): bitcoin.Psbt {
    const [head, ...rest] = psbts;
    for (const p of rest) head?.combine(p);
    return head!;
  }

  finalizePsbt(psbt: bitcoin.Psbt): bitcoin.Transaction {
    psbt.finalizeAllInputs();
    return psbt.extractTransaction();
  }
}
