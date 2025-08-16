import * as fs from 'fs';
import * as path from 'path';

// Configuration: Add your native packages here
const NATIVE_PACKAGES = [
  'bitcoin-merkle-native',
  // 'signature-verify-native',  // example for future
];

// Files that should be copied from each native package
const FILES_TO_COPY = [
  'index.js',
  'index.mjs',
  'index.d.ts'
];

interface CopyResult {
  packageName: string;
  copiedFiles: string[];
  missingFiles: string[];
  nodeFiles: string[];
}

class NativePackageCopier {
  private readonly distDir: string;
  private readonly rootDir: string;

  constructor() {
    this.rootDir = path.resolve(__dirname, '..');
    this.distDir = path.join(this.rootDir, 'dist');
  }

  /**
   * Copy all native packages to dist directory
   */
  public async copyAllNativePackages(): Promise<void> {
    console.log('Starting to copy native packages...\n');

    const results: CopyResult[] = [];

    for (const packageName of NATIVE_PACKAGES) {
      try {
        const result = await this.copyNativePackage(packageName);
        results.push(result);
      } catch (error) {
        console.error(`❌ Failed to copy package "${packageName}":`, error);
        process.exit(1);
      }
    }
  }

  /**
   * Copy single native package
   */
  private async copyNativePackage(packageName: string): Promise<CopyResult> {
    const sourceDir = path.join(this.rootDir, packageName);
    const targetDir = path.join(this.distDir, packageName);

    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    // Create target directory
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const result: CopyResult = {
      packageName,
      copiedFiles: [],
      missingFiles: [],
      nodeFiles: []
    };

    // Copy predefined files
    for (const fileName of FILES_TO_COPY) {
      const source = path.join(sourceDir, fileName);
      const target = path.join(targetDir, fileName);

      if (fs.existsSync(source)) {
        fs.copyFileSync(source, target);
        result.copiedFiles.push(fileName);
        console.log(`  ✅ ${packageName}/${fileName}`);
      } else {
        result.missingFiles.push(fileName);
        console.warn(`  ⚠️  ${packageName}/${fileName} - not found`);
      }
    }

    // Copy all .node files
    const allFiles = fs.readdirSync(sourceDir);
    const nodeFiles = allFiles.filter(file => file.endsWith('.node'));

    for (const nodeFile of nodeFiles) {
      const source = path.join(sourceDir, nodeFile);
      const target = path.join(targetDir, nodeFile);

      fs.copyFileSync(source, target);
      result.nodeFiles.push(nodeFile);
      console.log(`  ✅ ${packageName}/${nodeFile}`);
    }

    return result;
  }
}

// Execute if called directly
if (require.main === module) {
  const copier = new NativePackageCopier();
  copier.copyAllNativePackages().catch((error) => {
    console.error('❌ Copy operation failed:', error);
    process.exit(1);
  });
}

export { NativePackageCopier };