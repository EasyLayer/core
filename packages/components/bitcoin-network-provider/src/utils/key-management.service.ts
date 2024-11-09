import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
// import { ECPairFactory } from 'ecpair';
import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';

@Injectable()
export class KeyManagementService {
  private ecc: any; // TODO: create type

  // IMPORTANT: We are currently seeing problems with Jest and ecc.
  // In order to test the module normally, we DO NOT run the method in the constructor
  constructor() {
    // this.initEccLib();
  }

  private async initEccLib() {
    if (!this.ecc) {
      this.ecc = await import('tiny-secp256k1').catch(() => {
        throw new Error('Failed to load ecc module');
      });
      bitcoin.initEccLib(this.ecc);
    }
  }

  public generateMnemonic(): string {
    return bip39.generateMnemonic();
  }

  public seedFromMnemonic(mnemonic: string, passphrase: string): Buffer {
    return bip39.mnemonicToSeedSync(mnemonic, passphrase);
  }

  public async masterKeyFromSeed(seed: Buffer, network: bitcoin.Network): Promise<any> {
    await this.initEccLib();
    const bip32 = BIP32Factory(this.ecc);
    return bip32.fromSeed(seed, network);
  }

  public async publicKeyFromPrivateKey(privateKey: string): Promise<Buffer> {
    const keyPair = await this.keyPairFromPrivateKey(privateKey);
    return keyPair.publicKey;
  }

  public async keyPairFromPrivateKey(privateKey: string): Promise<any> {
    await this.initEccLib();
    const keyPair = this.ecc.fromPrivateKey(Buffer.from(privateKey, 'hex'));
    return keyPair;
  }

  public async verifySignatures(psbt: bitcoin.Psbt): Promise<boolean> {
    await this.initEccLib();
    return psbt.validateSignaturesOfAllInputs((pubkey, msghash, signature) => {
      return this.ecc.ecdsaVerify(signature, msghash, pubkey);
    });
  }

  public hashSHA256(value: Buffer): string {
    const hash = bitcoin.crypto.sha256(value);
    return hash.toString('hex');
  }
}
