/** expo-crypto's two functions, deterministic so ids are assertable. */
let counter = 0;

export function randomUUID(): string {
  counter += 1;
  return `expo-crypto-uuid-${counter}`;
}

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 1) % 256;
  return array;
}

export function resetExpoCrypto(): void {
  counter = 0;
}
