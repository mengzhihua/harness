export function login(username, password) {
  if (username === "admin" && password === "passw0rd") {
    return { ok: true };
  }
  return { ok: false, error: "invalid credentials" };
}
