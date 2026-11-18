# notification-extension TLS test fixtures

**テスト専用の鍵と証明書です。本番・検証環境を含め、テスト以外で使用しないでください。**
秘密鍵は公開されている前提のテスト用のもので、何の権限も持ちません。

`test/unit/NotificationExtensionClient.ts` が、ローカルの HTTPS サーバーと
`NotificationExtensionClient` の専用 agent の TLS 検証を確かめるために使います。

| ファイル | 内容 |
| --- | --- |
| `ca.crt` | テスト専用の private CA（テストでは正常系だけ `ca` として注入する） |
| `server.crt` / `server.key` | SAN `DNS:notification-extension.test`、有効期間 100 年 |
| `wrong-san.crt` / `wrong-san.key` | SAN `DNS:other.test`（ホスト名不一致の検証用） |
| `expired.crt` / `expired.key` | SAN `DNS:notification-extension.test`、有効期間 2000-01-01〜2001-01-01（期限切れの検証用） |

CA の秘密鍵と CSR は生成後に破棄しており、リポジトリには含めません。
再生成するときは、このディレクトリで以下を実行します（OpenSSL 3.4 以降。`-not_before`/`-not_after` を使うため）。
再生成すると全ファイルが置き換わります。

```bash
set -euo pipefail
# 一時ディレクトリで CA 鍵を作り、CA 鍵と CSR はリポジトリに残さない
work=$(mktemp -d)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$work/ca.key" -out ca.crt -days 36500 \
  -subj '/CN=miwkey notification extension TEST ONLY CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'

issue() { # name san [x509 validity options...]
  name=$1; san=$2; shift 2
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$name.key" -out "$work/$name.csr" -subj "/CN=$san"
  printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$san" > "$work/$name.ext"
  openssl x509 -req -in "$work/$name.csr" -CA ca.crt -CAkey "$work/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -extfile "$work/$name.ext" -out "$name.crt" "$@"
}

issue server notification-extension.test -days 36500
issue wrong-san other.test -days 36500
issue expired notification-extension.test -not_before 20000101000000Z -not_after 20010101000000Z
rm -rf "$work"
```
