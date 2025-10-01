import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import { ECPairFactory, ECPairAPI, ECPairInterface } from 'ecpair';
import { hash as fastSha256 } from 'fast-sha256';

@Injectable()
export class KeyManagementService {
  private ecc!: any; // tiny-compatible ecc
  private bip32!: ReturnType<typeof BIP32Factory>;
  private ECPair!: ECPairAPI;

  private initPromise: Promise<void> | null = null;

  private async ensureInit() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const secp = (await import('@bitcoinerlab/secp256k1')).default; // universal
      this.ecc = secp;
      bitcoin.initEccLib(secp);
      this.bip32 = BIP32Factory(secp);
      this.ECPair = ECPairFactory(secp);
    })();
    return this.initPromise;
  }

  public generateMnemonic(): string {
    return bip39.generateMnemonic();
  }

  public seedFromMnemonic(mnemonic: string, passphrase = ''): Buffer {
    return bip39.mnemonicToSeedSync(mnemonic, passphrase);
  }

  public async masterKeyFromSeed(seed: Buffer, network: bitcoin.Network) {
    await this.ensureInit();
    return this.bip32.fromSeed(seed, network);
  }

  public async keyPairFromPrivateKey(privateKeyHex: string): Promise<ECPairInterface> {
    await this.ensureInit();
    const priv = Buffer.from(privateKeyHex, 'hex');
    return this.ECPair.fromPrivateKey(priv);
  }

  public async publicKeyFromPrivateKey(privateKeyHex: string): Promise<Buffer> {
    const kp = await this.keyPairFromPrivateKey(privateKeyHex);
    return kp.publicKey;
  }

  public hashSHA256(value: Uint8Array | Buffer): string {
    const out = fastSha256(value);
    return Buffer.from(out).toString('hex');
  }

  public async verifySignatures(psbt: bitcoin.Psbt): Promise<boolean> {
    await this.ensureInit();
    try {
      return psbt.validateSignaturesOfAllInputs((pubkey, msghash, signature) =>
        this.ecc.ecdsaVerify(signature, msghash, pubkey)
      );
    } catch {
      return false;
    }
  }
}
