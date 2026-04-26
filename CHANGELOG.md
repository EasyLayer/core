## [1.2.1](https://github.com/EasyLayer/core/compare/v1.2.0...v1.2.1) (2026-04-26)


### Bug Fixes

* fixed bitcoin fee value for raw/bytes block; ([94ec291](https://github.com/EasyLayer/core/commit/94ec29107487b1ddbfad37abef62bd61c5ba5fbe))

# [1.2.0](https://github.com/EasyLayer/core/compare/v1.1.1...v1.2.0) (2026-03-23)


### Bug Fixes

* fixed bootstrap logging; fixed throwing errors in bitcoin providers; fixed browser setup; ([d380ff7](https://github.com/EasyLayer/core/commit/d380ff735e1f2634625909fda3d037e35e1e564d))

## [1.1.1](https://github.com/EasyLayer/core/compare/v1.1.0...v1.1.1) (2026-03-17)



# [1.1.0](https://github.com/EasyLayer/core/compare/v1.0.4...v1.1.0) (2026-03-17)


### Features

* added compression to sqlite as well; ([21aec9b](https://github.com/EasyLayer/core/commit/21aec9b996109ac14909e657419f14e759bb9bfa))
* added mempoolspace transport; ([cd5ba0a](https://github.com/EasyLayer/core/commit/cd5ba0a97d70e6cd48d5dbb1d6a427fa0b7a1972))



## [1.0.4](https://github.com/EasyLayer/core/compare/v1.0.3...v1.0.4) (2025-10-28)


### Features

* added helper generators into mempool aggregate; ([67cb0c8](https://github.com/EasyLayer/core/commit/67cb0c82c5d63e939aecc27e327e09458f910ca6))



## [1.0.3](https://github.com/EasyLayer/core/compare/v1.0.2...v1.0.3) (2025-10-18)


### Bug Fixes

* fixed bitcoin blocks loader pull strategy; ([15e890d](https://github.com/EasyLayer/core/commit/15e890d3886c9e1868116bd459d81fd003c87dae))



## [1.0.2](https://github.com/EasyLayer/core/compare/v1.0.0...v1.0.2) (2025-10-01)



## [1.0.1](https://github.com/EasyLayer/core/compare/v1.0.0...v1.0.1) (2025-10-01)



# [1.0.0](https://github.com/EasyLayer/core/compare/v0.10.0...v1.0.0) (2025-10-01)



## 0.10.0 (2025-08-13)

* feat: implemented new blockchain provider design; refactored mempool aggregate; ([546c684](https://github.com/EasyLayer/core/commit/546c684))



## <small>0.9.6 (2025-08-10)</small>

* chore: add bitpay github to allowed package url; ([ebdeda4](https://github.com/EasyLayer/core/commit/ebdeda4))
* chore: fixed github workflow; ([c113d62](https://github.com/EasyLayer/core/commit/c113d62))
* chore: fixed workflow; ([8913c1c](https://github.com/EasyLayer/core/commit/8913c1c))
* feat: implemented base p2p node provider for bitcoin network; ([f3e41f1](https://github.com/EasyLayer/core/commit/f3e41f1))
* feat: implemented spv validation; added p2p node provider and strategy; ([f27617b](https://github.com/EasyLayer/core/commit/f27617b))
* refactor: fixed yarn lock file; ([2f9475a](https://github.com/EasyLayer/core/commit/2f9475a))
* refactor: removed bitcore-p2p2 package as it cause lock file check failing; ([ec7b0d7](https://github.com/EasyLayer/core/commit/ec7b0d7))



## <small>0.9.5 (2025-08-05)</small>

* refactor: added reorg command for bitcoin mempool; ([4179f3a](https://github.com/EasyLayer/core/commit/4179f3a))



## <small>0.9.4 (2025-08-05)</small>

* feat: added bitcoin mempool cqrs componnets; ([c8c9c84](https://github.com/EasyLayer/core/commit/c8c9c84))



## <small>0.9.3 (2025-08-03)</small>

* refactor: fixed loading blocks timers; ([bfcd503](https://github.com/EasyLayer/core/commit/bfcd503))
* refactor: improved bitcoin components; ([668b5e8](https://github.com/EasyLayer/core/commit/668b5e8))
* refactor: optimized cqrs, eventstore, blocks queue, system aggregates; ([c8875ba](https://github.com/EasyLayer/core/commit/c8875ba))
* refactor: refactored bitcoin components; fixed unit tests; ([2361e92](https://github.com/EasyLayer/core/commit/2361e92))
* feat(cqrs,eventstore,bitcoin,evm): implemented: prune events and snaps; mempool for bitcoin; ([dde91f6](https://github.com/EasyLayer/core/commit/dde91f6))



## <small>0.9.2 (2025-07-20)</small>

* chore: fixed event store leak; refactored blockchains providers; fixed blockchains queues; ([0a3ea1d](https://github.com/EasyLayer/core/commit/0a3ea1d))



## <small>0.9.1 (2025-07-16)</small>

* refactor: fixed network transport modules; refactored cqrs components for bitcoin and evm; ([052eec5](https://github.com/EasyLayer/core/commit/052eec5))



## 0.9.0 (2025-07-15)

* BREAKING: refactored network transport; fixed aggregate model to json fn; change snapshot logic; ([67a0c49](https://github.com/EasyLayer/core/commit/67a0c49))



## 0.8.0 (2025-07-10)

* fix: fixed prepare branch to release script; ([881a212](https://github.com/EasyLayer/core/commit/881a212))
* fix: fixed unit tests; ([6dc6b39](https://github.com/EasyLayer/core/commit/6dc6b39))
* BREAKING: refactored network transport; refactored bitcoin and evm components; ([d104969](https://github.com/EasyLayer/core/commit/d104969))



## <small>0.7.6 (2025-06-17)</small>

* refactor: added fetching receipts for entire block in one request; ([fc0daf6](https://github.com/EasyLayer/core/commit/fc0daf6))



## <small>0.7.5 (2025-06-15)</small>

* refactor: fixed blocks loading batching and concurrency; ([2a6046c](https://github.com/EasyLayer/core/commit/2a6046c))



## <small>0.7.4 (2025-06-15)</small>

* refactor: fixed rate limiter for base params; fixed connection providers mamanger logic; ([104f99a](https://github.com/EasyLayer/core/commit/104f99a))



## <small>0.7.3 (2025-06-15)</small>

* refactor: fixed rate limiter for batch requests; ([44ea1b9](https://github.com/EasyLayer/core/commit/44ea1b9))



## <small>0.7.2 (2025-06-15)</small>

* refactor: fixed rate limiter and batch requests; ([bbccf98](https://github.com/EasyLayer/core/commit/bbccf98))



## <small>0.7.1 (2025-06-15)</small>

* infra: fixed release workflow; ([417ade9](https://github.com/EasyLayer/core/commit/417ade9))



## 0.7.0 (2025-06-15)

* refactor: removed json rpc node provider; ([b452e19](https://github.com/EasyLayer/core/commit/b452e19))



## <small>0.6.21 (2025-06-15)</small>

* refactor: chnaged rate limiter logic to add correct batch loading; ([f568eb0](https://github.com/EasyLayer/core/commit/f568eb0))



## <small>0.6.20 (2025-06-15)</small>

* feat: implemented receipts loading with blocks; ([c88fbee](https://github.com/EasyLayer/core/commit/c88fbee))
* refactor: fixed providers components normalization; ([f8c7c74](https://github.com/EasyLayer/core/commit/f8c7c74))



## <small>0.6.19 (2025-06-11)</small>

* refactor: fixed providers components normalization; ([ab07efd](https://github.com/EasyLayer/core/commit/ab07efd))



## <small>0.6.18 (2025-06-08)</small>

* refactor: fixed subscribe block problems with handling errors; ([3de33be](https://github.com/EasyLayer/core/commit/3de33be))



## <small>0.6.17 (2025-06-08)</small>

* refactor: improved blockchain provider to updated interfaces, normalization, calculation, tests; ([45ca6dc](https://github.com/EasyLayer/core/commit/45ca6dc))



## <small>0.6.16 (2025-06-07)</small>

* refactor: added rate limiter into providers; added max allowed gap into initial catchup into subscr; ([51db29e](https://github.com/EasyLayer/core/commit/51db29e))



## <small>0.6.15 (2025-06-07)</small>

* refactor: added initial catchup to subscribe load str; added reconnect to ws providers connections; ([7900da1](https://github.com/EasyLayer/core/commit/7900da1))



## <small>0.6.14 (2025-06-07)</small>

* refactor: rewrited subscribe block logic for evm loader; ([eca975b](https://github.com/EasyLayer/core/commit/eca975b))



## <small>0.6.13 (2025-06-04)</small>

* refactor: refactored blocks queue and load strategies; ([397e648](https://github.com/EasyLayer/core/commit/397e648))



## <small>0.6.12 (2025-05-23)</small>

* fix: added retry logic to commit flow to prevent hangs after unpublished events; ([d3569a8](https://github.com/EasyLayer/core/commit/d3569a8))



## <small>0.6.11 (2025-05-22)</small>

* chore: added licenses files into each package; ([db277ed](https://github.com/EasyLayer/core/commit/db277ed))
* chore: removed postinstall script; ([5f8b20e](https://github.com/EasyLayer/core/commit/5f8b20e))



## <small>0.6.10 (2025-05-22)</small>

* chore: added public settings to the components packages; ([4b7af65](https://github.com/EasyLayer/core/commit/4b7af65))



## <small>0.6.9 (2025-05-22)</small>

* chore: fixed preapre script; ([3063214](https://github.com/EasyLayer/core/commit/3063214))



## <small>0.6.6 (2025-05-22)</small>

* chore: fixed changelog file; ([15922ec](https://github.com/EasyLayer/core/commit/15922ec))
* chore: fixed lerna version updating; ([e65c80b](https://github.com/EasyLayer/core/commit/e65c80b))
* chore: fixed preapre script ([39a27a7](https://github.com/EasyLayer/core/commit/39a27a7))
* chore: fixed prepare script; ([821c601](https://github.com/EasyLayer/core/commit/821c601))
* chore: fixed prepare script; ([5e241c0](https://github.com/EasyLayer/core/commit/5e241c0))
* release v0.6.2 ([c32e620](https://github.com/EasyLayer/core/commit/c32e620))
* release v0.6.4 ([20d43b5](https://github.com/EasyLayer/core/commit/20d43b5))
* BREAKING: big changes after changing concept; ([f1f5e76](https://github.com/EasyLayer/core/commit/f1f5e76))



