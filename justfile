wasm-out := "packages/app/public"
example-plugins-out := "packages/app/public/example-plugins"

build-wasm:
    cargo build -p wasm-bridge --target wasm32-unknown-unknown --release
    mkdir -p {{wasm-out}}
    cp target/wasm32-unknown-unknown/release/wasm_bridge.wasm {{wasm-out}}/

# Phase-8 SDK example plugins. Compiles each `examples/*` crate to
# wasm32, copies the resulting `.wasm` into the app's public dir, and
# emits a JSON manifest with the SRI integrity hash next to each so
# the picker's "Install from URL" flow can install them at
# `/example-plugins/<name>.json`.
build-example-plugins:
    cargo build -p wasm-gain-plugin --target wasm32-unknown-unknown --release
    cargo build -p wasm-bitcrusher --target wasm32-unknown-unknown --release
    mkdir -p {{example-plugins-out}}
    cp target/wasm32-unknown-unknown/release/wasm_gain_plugin.wasm {{example-plugins-out}}/
    cp target/wasm32-unknown-unknown/release/wasm_bitcrusher.wasm {{example-plugins-out}}/
    node scripts/build-plugin-manifests.mjs

dev: build-wasm build-example-plugins
    cd packages/app && pnpm dev

build: build-wasm build-example-plugins
    cd packages/app && pnpm build

test-rust:
    cargo test --workspace

test-e2e: build-wasm build-example-plugins
    cd packages/app && pnpm exec playwright test

test: test-rust test-e2e
