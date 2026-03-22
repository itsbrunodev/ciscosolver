# cisco-solver

Offline-capable CCNA exam solver. Matches exam questions (including Hungarian translations) against a scraped database using vector search, with a local LLM as fallback for low-confidence or unseen questions.

## Installation

First off, you need to have [bun](https://bun.sh/) installed, then run:

```bash
git clone https://github.com/itsbrunodev/ciscosolver.git
cd ciscosolver
bun install
```

Then in order to start the server, you'll need to download the following files from [Xenova/bge-m3](https://huggingface.co/Xenova/bge-m3/tree/main).

- [config.json](https://huggingface.co/Xenova/bge-m3/blob/main/config.json)
- [tokenizer_config.json](https://huggingface.co/Xenova/bge-m3/blob/main/tokenizer_config.json)
- [tokenizer.json](https://huggingface.co/Xenova/bge-m3/blob/main/tokenizer.json)
- [onnx/model_quantized.onnx](https://huggingface.co/Xenova/bge-m3/blob/main/onnx/model_quantized.onnx) (rename this to model.onnx)
- [onnx/model.onnx_data](https://huggingface.co/Xenova/bge-m3/blob/main/onnx/model.onnx_data)

Put these files in the `model` directory.

## Running the server

Either download the installer from the [releases page](https://github.com/itsbrunodev/ciscosolver/releases) and run it, or run the following command:

```bash
bun start
```
