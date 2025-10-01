import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
import { KeyManagementService } from './key-management.service';

@Injectable()
export class WalletService {
  constructor(private readonly kms: KeyManagementService) {}

  async generateHDKeysPair(networkName: 'mainnet' | 'testnet') {
    const mnemonic = this.kms.generateMnemonic();
    const seed = this.kms.seedFromMnemonic(mnemonic);
    const net = networkName === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
    const master = await this.kms.masterKeyFromSeed(seed, net);

    const keypair = {
      privateKey: master.privateKey!.toString('hex'),
      publicKey: master.publicKey.toString('hex'),
      chainCode: master.chainCode.toString('hex'),
      network: networkName,
      depth: master.depth,
      index: master.index,
      parentFingerprint: master.parentFingerprint.toString(16).padStart(8, '0'),
    };

    return { mnemonic, seed: Buffer.from(seed).toString('hex'), keypair };
  }

  generateMnemonic(): string {
    return this.kms.generateMnemonic();
  }

  seedFromMnemonic(mnemonic: string, passphrase = ''): Buffer {
    return this.kms.seedFromMnemonic(mnemonic, passphrase);
  }

  async masterKeyFromSeed(seed: Buffer, networkName: 'mainnet' | 'testnet') {
    const net = networkName === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
    return this.kms.masterKeyFromSeed(seed, net);
  }

  async publicKeyFromPrivateKey(privateKey: string): Promise<Buffer> {
    return this.kms.publicKeyFromPrivateKey(privateKey);
  }

  hashPublicKey(publicKey: Buffer): string {
    return this.kms.hashSHA256(publicKey);
  }

  async addressP2WPKHFromPrivateKey(privateKey: string, network: bitcoin.Network): Promise<string> {
    const pubkey = await this.publicKeyFromPrivateKey(privateKey);
    const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
    if (!address) throw new Error('Failed to generate P2WPKH address from private key');
    return address;
  }

  addressP2WPKHFromPublicKey(publicKeyHex: string, network: bitcoin.Network): string {
    const pubkey = Buffer.from(publicKeyHex, 'hex');
    const { address } = bitcoin.payments.p2wpkh({ pubkey, network });
    if (!address) throw new Error('Failed to generate P2WPKH address from public key');
    return address;
  }

  async addressP2PKHFromPrivateKey(privateKey: string, network: bitcoin.Network): Promise<string> {
    const pubkey = await this.publicKeyFromPrivateKey(privateKey);
    const { address } = bitcoin.payments.p2pkh({ pubkey, network });
    if (!address) throw new Error('Failed to generate P2PKH address from private key');
    return address;
  }

  addressP2PKHFromPublicKey(publicKeyHex: string, network: bitcoin.Network): string {
    const pubkey = Buffer.from(publicKeyHex, 'hex');
    const { address } = bitcoin.payments.p2pkh({ pubkey, network });
    if (!address) throw new Error('Failed to generate P2PKH address from public key');
    return address;
  }

  addressP2WSHFromWitness(witnessScript: Buffer, network: bitcoin.Network): string {
    const { address } = bitcoin.payments.p2wsh({ redeem: { output: witnessScript, network } });
    if (!address) throw new Error('Failed to generate P2WSH address from witness');
    return address;
  }

  async addressP2TRFromPrivateKey(privateKey: string, network: bitcoin.Network): Promise<string> {
    const pubkey = await this.publicKeyFromPrivateKey(privateKey);
    const { address } = bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network });
    if (!address) throw new Error('Failed to generate P2TR address from private key');
    return address;
  }

  addressP2TRFromPublicKey(publicKey: Buffer, network: bitcoin.Network): string {
    const { address } = bitcoin.payments.p2tr({ internalPubkey: publicKey.slice(1, 33), network });
    if (!address) throw new Error('Failed to generate P2TR address from public key');
    return address;
  }

  childKeyFromMasterKey(masterKey: any, path = "m/44'/0'/0'/0/0") {
    const child = masterKey.derivePath(path);
    return {
      privateKey: child.privateKey?.toString('hex') ?? '',
      publicKey: child.publicKey.toString('hex'),
    };
  }
}
