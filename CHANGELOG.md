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



