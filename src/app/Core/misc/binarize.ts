export function binarizeArray(data: Uint8ClampedArray) {
  let output = new Array<boolean>(data.length / 4);
  let currentColor = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      output[i / 4] = true;
      if (data[i + 3] == 255) {
        currentColor = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      }
    } else {
      output[i / 4] = false;
    }
  }

  return { data: output, color: currentColor };
}

export function colorizeArray(input: Uint8ClampedArray, color: number[]) {
  let output = new Uint8ClampedArray(input.length * 4);
  for (let i = 0; i < output.length; i += 4) {
    if (input[i / 4 + 3] > 0) {
      output[i] = color[0];
      output[i + 1] = color[1];
      output[i + 2] = color[2];
      output[i + 3] = color[3];
    } else {
      output[i + 3] = 0;
    }
  }
  return output;
}
