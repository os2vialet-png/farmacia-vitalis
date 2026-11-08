// Política de contraseñas de Farmacia Vitalis.
// Se usa al cambiar contraseña temporal, al cambiarla voluntariamente y al restablecerla.

const COMMON_PASSWORDS = new Set([
  "password",
  "contraseña",
  "contrasena",
  "farmacia",
  "vitalis",
  "12345678",
  "123456789012",
  "qwerty123456",
  "qwerty",
  "administrador",
  "admin",
  "clave",
  "secreto",
  "bienvenido",
  "farmaciavitalis",
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Devuelve un mensaje de error en español, o null si la contraseña cumple la política. */
export function validatePasswordPolicy(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`;
  }

  if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(password)) {
    return "La contraseña debe incluir al menos una letra.";
  }

  if (!/\d/.test(password)) {
    return "La contraseña debe incluir al menos un número.";
  }

  const lower = password.toLowerCase();

  if (username && lower.includes(username.toLowerCase())) {
    return "La contraseña no puede contener el nombre de usuario.";
  }

  // Se compara también la parte alfabética: "password1234" o "Farmacia2026!" siguen siendo comunes.
  const lettersOnly = lower.replace(/[^a-záéíóúüñ]/g, "");

  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lettersOnly)) {
    return "Elige una contraseña menos común.";
  }

  if (lettersOnly.length < 4) {
    return "La contraseña debe combinar letras y números, no solo números con pocas letras.";
  }

  if (/^(.)\1+$/.test(lower) || /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer)/.test(lower) && lettersOnly.length < 6) {
    return "Evita secuencias o caracteres repetidos.";
  }

  return null;
}
