/* tslint:disable */
/* eslint-disable */

const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const { platform, arch } = process

let nativeBinding = null
let localFileExisted = false
let loadError = null

function isMusl() {
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      const lddPath = require('child_process').execSync('which ldd').toString().trim()
      return readFileSync(lddPath, 'utf8').includes('musl')
    } catch (e) {
      return true
    }
  } else {
    const { glibcVersionRuntime } = process.report.getReport().header
    return !glibcVersionRuntime
  }
}

switch (platform) {
  case 'win32':
    switch (arch) {
      case 'x64':
        localFileExisted = existsSync(join(__dirname, 'index.win32-x64-msvc.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./index.win32-x64-msvc.node')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        localFileExisted = existsSync(join(__dirname, 'index.win32-arm64-msvc.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./index.win32-arm64-msvc.node')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on Windows: ${arch}`)
    }
    break
  case 'darwin':
    switch (arch) {
      case 'x64':
        localFileExisted = existsSync(join(__dirname, 'index.darwin-x64.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./index.darwin-x64.node')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        localFileExisted = existsSync(join(__dirname, 'index.darwin-arm64.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./index.darwin-arm64.node')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on macOS: ${arch}`)
    }
    break
  case 'linux':
    switch (arch) {
      case 'x64':
        if (isMusl()) {
          localFileExisted = existsSync(join(__dirname, 'index.linux-x64-musl.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./index.linux-x64-musl.node')
            }
          } catch (e) {
            loadError = e
          }
        } else {
          localFileExisted = existsSync(join(__dirname, 'index.linux-x64-gnu.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./index.linux-x64-gnu.node')
            }
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm64':
        if (isMusl()) {
          localFileExisted = existsSync(join(__dirname, 'index.linux-arm64-musl.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./index.linux-arm64-musl.node')
            }
          } catch (e) {
            loadError = e
          }
        } else {
          localFileExisted = existsSync(join(__dirname, 'index.linux-arm64-gnu.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./index.linux-arm64-gnu.node')
            }
          } catch (e) {
            loadError = e
          }
        }
        break
      default:
        throw new Error(`Unsupported architecture on Linux: ${arch}`)
    }
    break
  default:
    throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`)
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError
  }
  throw new Error(`Failed to load native binding`)
}

const { BitcoinMerkleVerifier } = nativeBinding

module.exports.BitcoinMerkleVerifier = BitcoinMerkleVerifier