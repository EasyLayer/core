import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
import { KeyManagementService } from './key-management.service';

@Injectable()
export class WalletService {
  constructor(private readonly keyManagementService: KeyManagementService) {}

  public async generateHDKeysPair(networkName: string) {
    // TODO: add mnemonic type, add network
    const mnemonic = this.generateMnemonic();
    const seed = this.seedFromMnemonic(mnemonic);
    const keypair = await this.masterKeyFromSeed(seed, networkName);

    const formattedKeypair = {
      privateKey: keypair.privateKey.toString('hex'),
      publicKey: keypair.publicKey.toString('hex'),
      chainCode: keypair.chainCode.toString('hex'),
      network: keypair.network,
      depth: keypair.depth,
      index: keypair.index,
      parentFingerprint: keypair.parentFingerprint.toString(16).padStart(8, '0'),
    };

    return {
      mnemonic,
      seed: seed.toString('hex'),
      keypair: formattedKeypair,
    };
  }

  public generateMnemonic(): string {
    return this.keyManagementService.generateMnemonic();
  }

  public seedFromMnemonic(mnemonic: string, passphrase: string = ''): Buffer {
    const seed = this.keyManagementService.seedFromMnemonic(mnemonic, passphrase);
    if (!seed) {
      throw new Error('Failed to get seed from mnemonic');
    }

    return seed;
  }

  public async masterKeyFromSeed(seed: Buffer, networkName: string): Promise<any> {
    let network: bitcoin.Network = bitcoin.networks.testnet;

    if (networkName === 'mainnet') {
      network = bitcoin.networks.bitcoin;
    }

    return this.keyManagementService.masterKeyFromSeed(seed, network);
  }

  public async publicKeyFromPrivateKey(privateKey: string): Promise<Buffer> {
    const pubKey = await this.keyManagementService.publicKeyFromPrivateKey(privateKey);
    if (!pubKey) {
      throw new Error('Failed to get public key from private key');
    }
    return pubKey;
  }

  public hashPublicKey(publicKey: Buffer, algorithm: string = 'sha256'): string {
    if (algorithm) {
      return this.keyManagementService.hashSHA256(publicKey);
    } else {
      throw new Error('');
    }
  }

  // (P2SH)
  public async addressP2SHFromPrivateKey(redeemScript: Buffer, network: bitcoin.Network): Promise<string> {
    const { address } = bitcoin.payments.p2sh({ redeem: { output: redeemScript, network } });
    if (!address) {
      throw new Error('Failed to generate P2SH address from redeem');
    }
    return address;
  }

  // Segwit (P2WSH)
  public addressP2WSHFromWitness(witnessScript: Buffer, network: bitcoin.Network): string {
    const { address } = bitcoin.payments.p2wsh({ redeem: { output: witnessScript, network } });
    if (!address) {
      throw new Error('Failed to generate P2WSH address from witness');
    }
    return address;
  }

  // Segwit Bech32 (P2WPKH)
  public addressP2WPKHFromPublicKey(publicKey: string, network: bitcoin.Network): string {
    const publicKeyBuffer = Buffer.from(publicKey, 'hex');
    const { address } = bitcoin.payments.p2wpkh({ pubkey: publicKeyBuffer, network });
    if (!address) {
      throw new Error('Failed to generate P2WPKH address from public key');
    }
    return address;
  }

  // Segwit Bech32 (P2WPKH)
  public async addressP2WPKHFromPrivateKey(privateKey: string, network: bitcoin.Network): Promise<string> {
    const pubkey = await this.publicKeyFromPrivateKey(privateKey);
    const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
    if (!address) {
      throw new Error('Failed to generate P2WPKH address from private key');
    }
    return address;
  }

  // which starts with "1" (P2PKH)
  public async addressP2PKHFromPrivateKey(privateKey: string, network: bitcoin.Network): Promise<string> {
    const pubkey = await this.publicKeyFromPrivateKey(privateKey);
    const { address } = bitcoin.payments.p2pkh({ pubkey, network });
    if (!address) {
      throw new Error('Failed to generate P2PKH address from private key');
    }
    return address;
  }

  // which starts with "1" (P2PKH)
  public addressP2PKHFromPublicKey(publicKey: string, network: bitcoin.Network): string {
    const publicKeyBuffer = Buffer.from(publicKey, 'hex');
    const { address } = bitcoin.payments.p2pkh({ pubkey: publicKeyBuffer, network });
    if (!address) {
      throw new Error('Failed to generate P2PKH address from public key');
    }
    return address;
  }

  // Taproot (P2TR)
  public addressP2TRFromPublicKey(publicKey: Buffer, network: bitcoin.Network): string {
    const { address } = bitcoin.payments.p2tr({
      internalPubkey: publicKey.slice(1, 33), // Снимаем первый байт
      network,
    });

    if (!address) {
      throw new Error('Failed to generate P2TR(Taproot) address from public key');
    }

    return address;
  }

  // Taproot (P2TR)
  public async addressP2TRFromPrivateKey(privateKey: string, network: bitcoin.Network): Promise<string> {
    const pubkey = await this.publicKeyFromPrivateKey(privateKey);
    const { address } = bitcoin.payments.p2tr({
      internalPubkey: pubkey.slice(1, 33), // Снимаем первый байт
      network,
    });

    if (!address) {
      throw new Error('Failed to generate P2TR(Taproot) address from private key');
    }

    return address;
  }

  public childKeyFromMasterKey(masterKey: any, path: string = "m/44'/0'/0'/0/0"): any {
    const childKey = masterKey.derivePath(path);
    return {
      privateKey: childKey.privateKey.toString('hex'),
      publicKey: childKey.publicKey.toString('hex'),
    };
  }
}
