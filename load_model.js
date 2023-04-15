async function loadModel(filename) {
  console.log("Loading model:", filename);
  // Load the model from json file
  var model = await (await fetch(`models/${filename}.json`)).json();

  const { device, queue } = await initializeWebGPU();
  const minStorageBufferOffsetAlignment = 1; // device.limits.minStorageBufferOffsetAlignment; // This was breaking things. Probably should check later.
  bufferSizeCalc = (dimA, dimB = 1) => alignedSize(dimA * dimB * Float32Array.BYTES_PER_ELEMENT, minStorageBufferOffsetAlignment);

  const { block_size: context_size, vocab_size, n_embd, n_head: n_heads, n_layer: n_layers, bias: biasEnabled } = model.params;
  console.log("context_size", context_size, "vocab_size", vocab_size, "n_embd", n_embd, "n_heads", n_heads, "n_layers", n_layers);

  const hidden_size = n_embd * 4; // Transformer block has 4 hidden layers by default, not a param.
  const attentionDotProductScale = 1 / Math.sqrt(n_embd / n_heads);

  const embeddings = model["transformer.wte.weight"].values.flat();
  const embdBuffer = createBuffer(device, bufferSizeCalc(vocab_size, n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  queue.writeBuffer(embdBuffer, 0, new Float32Array(embeddings));

  const posEmbeddings = model["transformer.wpe.weight"].values.flat();
  const posEmbdBuffer = createBuffer(device, bufferSizeCalc(context_size, n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
  queue.writeBuffer(posEmbdBuffer, 0, new Float32Array(posEmbeddings));

  const layer_buffers = [];

  for (let i = 0; i < n_layers; i++) {
    const buffers = [];
    const prefix = `transformer.h.${i}.`;

    const layerNormAttentionGamma = model[`${prefix}ln_1.weight`].values.flat();
    const layerNormAttentionBeta = biasEnabled ? model[`${prefix}ln_1.bias`].values.flat() : new Array(n_embd).fill(0);
    const normAttentionGammaBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const normAttentionBetaBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    queue.writeBuffer(normAttentionGammaBuffer, 0, new Float32Array(layerNormAttentionGamma));
    queue.writeBuffer(normAttentionBetaBuffer, 0, new Float32Array(layerNormAttentionBeta));
    buffers.push(normAttentionGammaBuffer, normAttentionBetaBuffer);

    const qkv_weights = model[`${prefix}attn.c_attn.weight`].values.flat();
    const qkv_bias = biasEnabled ? model[`${prefix}attn.c_attn.bias`].values.flat() : new Array(3 * n_embd).fill(0);
    const qkvWeightsBuffer = createBuffer(device, bufferSizeCalc(n_embd, 3 * n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const qkvBiasBuffer = createBuffer(device, bufferSizeCalc(3 * n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    queue.writeBuffer(qkvWeightsBuffer, 0, new Float32Array(qkv_weights));
    queue.writeBuffer(qkvBiasBuffer, 0, new Float32Array(qkv_bias));
    buffers.push(qkvWeightsBuffer, qkvBiasBuffer);

    const linear_weights = model[`${prefix}attn.c_proj.weight`].values.flat();
    const linear_bias = biasEnabled ? model[`${prefix}attn.c_proj.bias`].values.flat() : new Array(n_embd).fill(0);
    const linearWeightsBuffer = createBuffer(device, bufferSizeCalc(n_embd, n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const linearBiasBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    queue.writeBuffer(linearWeightsBuffer, 0, new Float32Array(linear_weights));
    queue.writeBuffer(linearBiasBuffer, 0, new Float32Array(linear_bias));
    buffers.push(linearWeightsBuffer, linearBiasBuffer);

    const layerNormLinearGamma = model[`${prefix}ln_2.weight`].values.flat();
    const layerNormLinearBeta = biasEnabled ? model[`${prefix}ln_2.bias`].values.flat() : new Array(n_embd).fill(0);
    const normLinearGammaBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const normLinearBetaBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    queue.writeBuffer(normLinearGammaBuffer, 0, new Float32Array(layerNormLinearGamma));
    queue.writeBuffer(normLinearBetaBuffer, 0, new Float32Array(layerNormLinearBeta));
    buffers.push(normLinearGammaBuffer, normLinearBetaBuffer);

    const firstLayerWeights = model[`${prefix}mlp.c_fc.weight`].values.flat();
    const firstLayerBias = biasEnabled ? model[`${prefix}mlp.c_fc.bias`].values.flat() : new Array(hidden_size).fill(0);
    const firstLayerWeightsBuffer = createBuffer(device, bufferSizeCalc(n_embd, hidden_size), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const firstLayerBiasBuffer = createBuffer(device, bufferSizeCalc(hidden_size), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    queue.writeBuffer(firstLayerWeightsBuffer, 0, new Float32Array(firstLayerWeights));
    queue.writeBuffer(firstLayerBiasBuffer, 0, new Float32Array(firstLayerBias));
    buffers.push(firstLayerWeightsBuffer, firstLayerBiasBuffer);

    const secondLayerWeights = model[`${prefix}mlp.c_proj.weight`].values.flat();
    const secondLayerBias = biasEnabled ? model[`${prefix}mlp.c_proj.bias`].values.flat() : new Array(n_embd).fill(0);
    const secondLayerWeightsBuffer = createBuffer(device, bufferSizeCalc(hidden_size, n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const secondLayerBiasBuffer = createBuffer(device, bufferSizeCalc(hidden_size), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    queue.writeBuffer(secondLayerWeightsBuffer, 0, new Float32Array(secondLayerWeights));
    queue.writeBuffer(secondLayerBiasBuffer, 0, new Float32Array(secondLayerBias));
    buffers.push(secondLayerWeightsBuffer, secondLayerBiasBuffer);

    layer_buffers.push(buffers);
  }

  const layerNormGamma = model["transformer.ln_f.weight"].values;
  const layerNormBeta = biasEnabled ? model["transformer.ln_f.bias"].values : new Array(n_embd).fill(0);
  const normGammaBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const normBetaBuffer = createBuffer(device, bufferSizeCalc(n_embd), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  queue.writeBuffer(normGammaBuffer, 0, new Float32Array(layerNormGamma));
  queue.writeBuffer(normBetaBuffer, 0, new Float32Array(layerNormBeta));

  const deEmbeddings = model["lm_head.weight"].values.flat();
  const deEmbedBuffer = createBuffer(device, bufferSizeCalc(n_embd, vocab_size), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  queue.writeBuffer(deEmbedBuffer, 0, new Float32Array(deEmbeddings));

  return {
    device,
    queue,
    params: {
      attentionDotProductScale,
      biasEnabled,
      n_embd,
      n_heads,
      n_layers,
      vocab_size,
      hidden_size,
      context_size,
    },
    embdBuffer,
    posEmbdBuffer,
    layer_buffers,
    normGammaBuffer,
    normBetaBuffer,
    deEmbedBuffer,
  };
}

let itos = null;
let stoi = null;
let modelParams = null;
let bufferSizeCalc = null;

(async () => {
  modelParams = await loadModel("bad_shakespeare");
  console.log("Params:", modelParams);

  const tokenDict = await (await fetch("models/tokens.json")).json();

  itos = tokenDict.itos;
  stoi = tokenDict.stoi;

  console.log("Tokens:", tokenDict);
  console.log("Unique Tokens:", new Set(Object.values(tokenDict.itos)));

  console.log("Model finished loading.");
})();

async function runInference(prompt) {
  if (!modelParams) {
    console.log("Model not loaded yet");
    return;
  }

  const { device, queue, params, embdBuffer, posEmbdBuffer, layer_buffers, normGammaBuffer, normBetaBuffer, deEmbedBuffer } = modelParams;
  const { attentionDotProductScale, biasEnabled, n_embd, n_heads, n_layers, vocab_size, hidden_size, context_size } = params;

  const seq_length = prompt.length;
  const inputMatrix = new Float32Array(seq_length * vocab_size);
  for (let i = 0; i < seq_length; i++) {
    inputMatrix[i * vocab_size + prompt[i]] = 1;
  }
  // printMatrix(seq_length, vocab_size, new Float32Array(inputMatrix));
  const inputBuffer = createBuffer(device, bufferSizeCalc(seq_length, vocab_size), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  queue.writeBuffer(inputBuffer, 0, inputMatrix);

  const startTime = performance.now();
  const result = await runGPT(
    device,
    queue,
    seq_length,
    vocab_size,
    n_embd,
    n_heads,
    n_layers,
    attentionDotProductScale,
    inputBuffer,
    embdBuffer,
    posEmbdBuffer,
    layer_buffers,
    normGammaBuffer,
    normBetaBuffer,
    deEmbedBuffer
  );
  const endTime = performance.now();
  console.log(`Time: ${endTime - startTime} ms`);

  // printMatrix(seq_length, vocab_size, new Float32Array(result));

  // take only the last row, it is 4 am please don't judge me
  const lastRow = new Float32Array(vocab_size);
  const resultArray = new Float32Array(result);
  for (let i = 0; i < vocab_size; i++) {
    lastRow[i] = resultArray[(seq_length - 1) * vocab_size + i];
  }
  return lastRow;
}

async function runGPT(
  device,
  queue,
  seq_length,
  vocab_size,
  n_embd,
  n_heads,
  n_layers,
  attentionDotProductScale,
  inputBuffer,
  embdBuffer,
  posEmbdBuffer,
  layer_buffers,
  normGammaBuffer,
  normBetaBuffer,
  deEmbedBuffer
) {
  const commandEncoder = device.createCommandEncoder();

  const embdOutputBuffer = inlineMatMul(device, queue, commandEncoder, inputBuffer, embdBuffer, seq_length, n_embd, vocab_size);
  // Crop the position embeddings to the correct size.
  const posEmbdOutputBuffer = createBuffer(
    device,
    bufferSizeCalc(seq_length, n_embd),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  );
  commandEncoder.copyBufferToBuffer(
    posEmbdBuffer, // Source buffer (original position embeddings)
    0, // Source offset (starting from the beginning of the buffer)
    posEmbdOutputBuffer, // Destination buffer (cropped buffer)
    0, // Destination offset (starting from the beginning of the cropped buffer)
    bufferSizeCalc(seq_length, n_embd) // Number of bytes to copy
  );
  // Residual connection is just elementwise addition, can be used for combining embedding and position embedding.
  const embeddedInputBuffer = inlineResidual(device, queue, commandEncoder, seq_length, n_embd, embdOutputBuffer, posEmbdOutputBuffer);
  let layerBuffer = embeddedInputBuffer;

  for (let i = 0; i < n_layers; i++) {
    const layer_params = layer_buffers[i];
    const blockOutputBuffer = transformerBlock(
      device,
      queue,
      commandEncoder,
      seq_length,
      n_embd,
      n_heads,
      attentionDotProductScale,
      layerBuffer,
      ...layer_params
    );
    layerBuffer = blockOutputBuffer;
  }

  const layerNormOutputBuffer = inlineLayerNorm(device, queue, commandEncoder, seq_length, n_embd, layerBuffer, normGammaBuffer, normBetaBuffer);

  const deEmbedOutputBuffer = inlineMatMul(device, queue, commandEncoder, layerNormOutputBuffer, deEmbedBuffer, seq_length, vocab_size, n_embd);

  const outputBufferSize = bufferSizeCalc(seq_length, vocab_size);
  const outputBuffer = createBuffer(device, outputBufferSize, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  commandEncoder.copyBufferToBuffer(deEmbedOutputBuffer, 0, outputBuffer, 0, outputBufferSize);
  queue.submit([commandEncoder.finish()]);

  await outputBuffer.mapAsync(GPUMapMode.READ);

  return outputBuffer.getMappedRange();
}

async function generateFromModel(prompt, max_new_tokens, temperature) {
  if (!modelParams || !stoi || !itos) {
    console.log("Model not loaded yet");
    return;
  }

  console.log("Starting generation with prompt", prompt);
  prompt = prompt.split("").map((c) => stoi[c]);
  console.log("Parsed prompt", prompt);

  const context_size = modelParams.params.context_size;
  console.log("block_size", context_size);
  for (let i = 0; i < max_new_tokens; i++) {
    // console.log("prompt", prompt);
    const idx_cond = prompt.slice(-context_size);
    // console.log("running inference on sequence", idx_cond);
    const logits = await runInference(idx_cond);
    // console.log("logits", logits);
    // pluck the logits at the final step and scale by desired temperature
    const logits_scaled = logits; // / temperature;
    // apply softmax to convert logits to (normalized) probabilities
    const probs = simpleSoftmax(logits_scaled);
    console.log("probs", probs);
    // sample from the distribution
    const idx_next = sampleFromDistribution(probs);
    // append sampled index to the running sequence and continue
    // console.log("generated", idx_next);
    prompt = prompt.concat(idx_next);
  }

  console.log("Output ints:", prompt);
  const text = prompt.map((i) => itos[i]).join("");
  console.log("Output:", text);
}

function simpleSoftmax(input) {
  const output = new Float32Array(input.length);
  let max = input[0];

  // Find the maximum value in the input array
  for (let i = 1; i < input.length; i++) {
    if (input[i] > max) {
      max = input[i];
    }
  }

  // Calculate the exponentials, and keep track of the sum
  let sumExp = 0.0;
  for (let i = 0; i < input.length; i++) {
    const exp = Math.exp(input[i] - max);
    output[i] = exp;
    sumExp += exp;
  }

  // Normalize the output array by dividing each value by the sum of exponentials
  for (let i = 0; i < output.length; i++) {
    output[i] /= sumExp;
  }

  return output;
}

function sampleFromDistribution(probs) {
  const r = Math.random();
  console.log("r", r);
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    sum += probs[i];
    if (r <= sum) {
      return i;
    }
  }
}