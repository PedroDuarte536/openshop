// A small deny-list of very common passwords (server only; not shipped to browsers). Matching ignores case and
// trailing digits/symbols, so "Password2024!" counts as "password".
const LIST = `password passw0rd p@ssword p@ssw0rd qwerty qwertyuiop qwertyui asdfghjkl asdfghjk zxcvbnm zxcvbnml 1q2w3e4r 1q2w3e4r5t
1qaz2wsx qazwsx qazwsxedc abcdefgh abcdefghij abcd1234 iloveyou letmein welcome welcome1 admin administrator root
changeme changeit secret monkey dragon master shadow sunshine princess football baseball superman batman trustno1
starwars whatever freedom nothing computer internet michael jennifer jordan hunter ranger buster soccer harley
charlie andrew thomas robert daniel matthew jessica ashley summer winter spring autumn january february
december hello helloworld mustang access flower lovely loveme iloveu babygirl samsung google facebook linkedin
microsoft apple pokemon naruto minecraft chocolate cookie cheese pepper ginger banana orange purple silver golden
diamond killer pussy biteme fuckyou asshole 123456 1234567 12345678 123456789 1234567890 0987654321 987654321
11111111 00000000 12121212 123123123 123321 654321 666666 696969 88888888 99999999 qwe123 qwerty123 password123
aa123456 abc123 abc12345 zaq12wsx zaq1zaq1 !qaz2wsx q1w2e3r4 q1w2e3r4t5 1234qwer qwer1234 asdf1234 passport
shop shopping openshop store onlineshop mystore myshop customer backoffice manager service support
default guest test testing test1234 demo demo1234 user username login logmein adminadmin administrator1
temp temporary pass passwort motdepasse contrasena senha wachtwoord haslo salasana lozinka`.split(/\s+/).filter(Boolean);

const SET = new Set(LIST);

export function isCommonPassword(pw: string): boolean {
  const low = pw.trim().toLowerCase();
  if (SET.has(low)) return true;
  const stem = low.replace(/[\d\W_]+$/u, "");
  return stem.length >= 3 && SET.has(stem);
}
