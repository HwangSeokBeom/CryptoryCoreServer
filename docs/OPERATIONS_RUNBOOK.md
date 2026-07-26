# Cryptory 운영 Runbook

검증 기준일: 2026-07-26
리전: `ap-northeast-2`
EC2: `i-0f25371487d81c606`
도메인: `https://cryptory.duckdns.org`
REST/WS 내부 포트: `3000`
PM2 앱: `cryptory-core-server`

SSH는 공개하지 않는다. 집과 회사 모두 AWS 인증 후 SSM Session Manager로
접속한다.

## 1. 접속

```bash
aws sts get-caller-identity

aws ssm start-session \
  --region ap-northeast-2 \
  --target i-0f25371487d81c606
```

접속 후:

```bash
sudo -iu ec2-user
cd /home/ec2-user/CryptoryCoreServer
```

## 2. 매일 확인

외부:

```bash
curl -fsS https://cryptory.duckdns.org/health | jq
curl -fsS https://cryptory.duckdns.org/ready | jq
```

서버:

```bash
sudo systemctl is-active nginx pm2-ec2-user redis6
sudo systemctl is-enabled nginx pm2-ec2-user redis6
sudo -u ec2-user -H pm2 status
sudo -u ec2-user -H pm2 describe cryptory-core-server
curl -fsS http://127.0.0.1:3000/health | jq
curl -fsS http://127.0.0.1:3000/ready | jq
redis6-cli -h 127.0.0.1 ping
```

정상 기준:

- Nginx, PM2, Redis가 active/enabled
- `cryptory-core-server`가 online
- `/health` 200
- `/ready`의 database/redis가 모두 `ok`
- App Review mode에서 거래성 endpoint가
  `403 FEATURE_DISABLED_FOR_APP_STORE`
- FCM이 `enabled=true`, `dryRun=false`
- 가격 알림 worker가 주기적으로 tick

## 3. 로그

```bash
sudo -u ec2-user -H pm2 logs cryptory-core-server --lines 200 --nostream
sudo tail -n 200 /home/ec2-user/.pm2/logs/cryptory-core-server-out.log
sudo tail -n 200 /home/ec2-user/.pm2/logs/cryptory-core-server-error.log
sudo tail -n 200 /var/log/nginx/access.log
sudo tail -n 200 /var/log/nginx/error.log
sudo journalctl -u pm2-ec2-user -n 200 --no-pager
sudo journalctl -u redis6 -n 200 --no-pager
```

FCM과 가격 알림:

```bash
sudo -u ec2-user -H pm2 logs cryptory-core-server --lines 500 --nostream 2>&1 \
  | grep -Ei '\\[FCM\\]|PriceAlertWorker|price-alert|push-token'
```

WebSocket 업그레이드 기록:

```bash
sudo grep ' 101 ' /var/log/nginx/access.log | tail -n 50
```

CloudWatch Logs:

- `/project-services/cryptory/app`
- `/project-services/cryptory/nginx`
- 보관 기간: 14일

전체 FCM token, Firebase private key, JWT, 거래소 API key, Authorization header를
로그나 화면에 출력하지 않는다.

## 4. 안전한 재시작

```bash
sudo -u ec2-user -H bash -lc '
  cd /home/ec2-user/CryptoryCoreServer
  pm2 restart cryptory-core-server --update-env
  pm2 save
'

sleep 5
curl -fsS http://127.0.0.1:3000/ready | jq
curl -fsS https://cryptory.duckdns.org/ready | jq
```

Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Redis는 앱과 DB가 정상인데 Redis probe만 실패할 때 로그와 메모리를 먼저 확인한
후에만 재시작한다.

```bash
sudo systemctl status redis6 --no-pager
sudo journalctl -u redis6 -n 200 --no-pager
sudo systemctl restart redis6
curl -fsS http://127.0.0.1:3000/ready | jq
```

## 5. 환경설정과 App Review

운영 파일:

- `/home/ec2-user/CryptoryCoreServer/.env.production`
- 권한: `600`, 소유자: `ec2-user`

Secrets Manager:

- `production/cryptory/database`
- `production/cryptory/runtime`
- `production/cryptory/review-account`

App Review 운영값:

- `APP_STORE_REVIEW_MODE=true`
- 주문·거래·송금·입출금·지갑·private trading/private WS는 false
- read-only portfolio는 true

Firebase/FCM:

- Firebase project: `cryptory-342cf`
- FCM enabled
- dry-run disabled
- price alert worker enabled

비밀값은 Secrets Manager에 먼저 변경하고 승인된 동기화 절차로 환경 파일을
갱신한다. 환경 파일 전체, Firebase private key, 리뷰 계정 비밀번호를 출력하지
않는다.

## 6. 배포

운영 서버에서 임의로 `git pull`하지 않는다.

1. clean 브랜치에서 `npm ci`, build, lint, unit/integration tests를 완료한다.
2. disposable PostgreSQL에서 모든 Prisma migration을 rehearsal한다.
3. Firebase/Google dependency audit 결과를 검토한다.
4. exact commit SHA와 rollback artifact를 기록한다.
5. RDS snapshot 상태를 확인한다.
6. 새 artifact를 별도 경로에 준비하고 환경 validator를 실행한다.
7. PM2 전환 후 localhost `/health`, `/ready`, Redis, WSS를 확인한다.
8. public HTTPS/WSS와 App Review 차단을 확인한다.

운영 DB에는 `npx prisma migrate deploy`만 사용한다. `prisma db push`, reset,
개발 seed는 사용하지 않는다.

## 7. 장애 대응

가격 알림이 오지 않을 때:

1. Firebase 초기화 로그 확인
2. worker tick 확인
3. 활성 alert와 token 존재 여부를 값 노출 없이 확인
4. `messaging/registration-token-not-registered` 발생 시 해당 token 비활성화
5. 실제 기기 APNs 권한과 production entitlement 확인

WSS 장애:

1. `/ready` 확인
2. Nginx `101` 기록과 error log 확인
3. PM2 restart count 확인
4. Redis와 upstream market provider 상태 확인

App Review 차단 실패:

- 즉시 출시 중단
- Secrets Manager의 review/feature flag 존재 여부만 확인
- 거래성 endpoint가 403인지 회귀 검증
- flags를 임의로 완화하지 않는다.

## 8. 알림, 백업, 인증서

```bash
aws sns list-subscriptions-by-topic \
  --region ap-northeast-2 \
  --topic-arn arn:aws:sns:ap-northeast-2:486208157237:project-services-ops-alerts

sudo certbot certificates
sudo systemctl status certbot-renew.timer --no-pager
```

DB 복구는 암호화 snapshot에서 새 RDS를 복원해 검증한 뒤 연결을 전환한다.
기존 DB에 파괴적 복구 명령을 실행하지 않는다.
