import type { NextConfig } from "next";
import CopyPlugin from "copy-webpack-plugin";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // ONNX Runtime WASM needs its .mjs and .wasm files in the chunks dir
      // so the dynamic import() in onnxruntime-web can find them
      config.plugins.push(
        new CopyPlugin({
          patterns: [
            {
              from: path.join(__dirname, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs"),
              to: path.join(config.output.path!, "static/chunks/"),
            },
            {
              from: path.join(__dirname, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
              to: path.join(config.output.path!, "static/chunks/"),
            },
          ],
        })
      );
    }
    return config;
  },
};

export default nextConfig;
