
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const KEY_LENGTH = 64;
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELIZATION,
        maxmem: MAX_MEMORY,
      },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(key as Buffer);
      },
    );
  });
}

export async function hashPassword(
  password: string,
): Promise<string> {
  if (password.length < 12 || password.length > 128) {
    throw new Error(
      "La contraseña debe tener entre 12 y 128 caracteres.",
    );
  }

  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt);

  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

// Ejecuta el mismo costo de scrypt que una verificación real. Se usa cuando el
// usuario no existe o está inactivo, para que el tiempo de respuesta no revele
// si un nombre de usuario existe.
export async function burnPasswordTime(password: string): Promise<void> {
  await deriveKey(password, Buffer.alloc(16));
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parts = storedHash.split("$");

    if (parts.length !== 6) return false;

    const [
      algorithm,
      cost,
      blockSize,
      parallelization,
      saltHex,
      hashHex,
    ] = parts;

    if (
      algorithm !== "scrypt" ||
      Number(cost) !== COST ||
      Number(blockSize) !== BLOCK_SIZE ||
      Number(parallelization) !== PARALLELIZATION ||
      !/^[a-f0-9]{32}$/i.test(saltHex) ||
      !/^[a-f0-9]{128}$/i.test(hashHex)
    ) {
      return false;
    }

    const salt = Buffer.from(saltHex, "hex");
    const originalHash = Buffer.from(hashHex, "hex");

    const candidateHash = await deriveKey(password, salt);

    return timingSafeEqual(originalHash, candidateHash);
  } catch {
    return false;
  }
}
