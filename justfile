wasm-out := "packages/app/public"

build-wasm:
    cargo build -p wasm-bridge --target wasm32-unknown-unknown --release
    mkdir -p {{wasm-out}}
    cp target/wasm32-unknown-unknown/release/wasm_bridge.wasm {{wasm-out}}/

dev: build-wasm
    cd packages/app && pnpm dev

build: build-wasm
    cd packages/app && pnpm build
