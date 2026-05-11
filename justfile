wasm-out := "packages/app/public"
example-plugins-out := "packages/app/public/example-plugins"

build-wasm:
    cargo build -p wasm-bridge --target wasm32-unknown-unknown --release
    mkdir -p {{wasm-out}}
    cp target/wasm32-unknown-unknown/release/wasm_bridge.wasm {{wasm-out}}/

# Phase-8 SDK example plugins. Compiles each `examples/*` crate to
# wasm32 and copies the resulting `.wasm` into the app's public dir
# so the loader's Playwright spec can fetch it at `/example-plugins/…`.
build-example-plugins:
    cargo build -p wasm-gain-plugin --target wasm32-unknown-unknown --release
    mkdir -p {{example-plugins-out}}
    cp target/wasm32-unknown-unknown/release/wasm_gain_plugin.wasm {{example-plugins-out}}/

dev: build-wasm build-example-plugins
    cd packages/app && pnpm dev

build: build-wasm build-example-plugins
    cd packages/app && pnpm build

test-rust:
    cargo test --workspace

test-e2e: build-wasm build-example-plugins
    cd packages/app && pnpm exec playwright test

test: test-rust test-e2e
