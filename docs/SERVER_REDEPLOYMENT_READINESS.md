# Cryptory server redeployment readiness

검증 기준일: 2026-07-26
상태: `PUBLIC_RUNTIME_READY_WITH_BLOCKERS`

## 배치된 런타임

- AWS region: `ap-northeast-2`
- EC2: `i-0f25371487d81c606`
- Elastic IP: `3.36.28.185`
- public host: `cryptory.duckdns.org`
- source: `/home/ec2-user/CryptoryCoreServer`
- source commit: `5c33b3c802a2a6d7e32eac8e7832febb054c7a37`
- Node.js: 22
- canonical port: `3000`
- PM2 application: `cryptory-core-server`
- Redis: instance-local loopback service
- PostgreSQL: private shared RDS의 전용 `cryptory` database와 전용 role

`3002`는 일부 개발 클라이언트의 로컬 기본값에서 비롯된 값이다. 운영 source,
PM2, Nginx의 canonical upstream은 모두 `127.0.0.1:3000`이다.

## 완료된 실행 검증

- Prisma migrations 11/11
- PM2 systemd 부팅 복구 및 process online
- localhost/public `/health`와 `/ready`
- HTTP to HTTPS redirect
- TLS certificate와 자동 갱신 timer
- WSS `/ws/market` handshake
- 리뷰 계정 회원가입·로그인
- FCM token 등록·삭제 persistence
- App Review configuration
- 주문·거래·송금·입출금·지갑 endpoint 차단
- 외부에 3000, 3002, 5432, 6379가 노출되지 않음
- 서비스 IAM role이 자기 서비스 secret만 읽고 다른 서비스 secret은 거부

## 데이터와 백업

- 기존 운영 데이터: `NO_BACKUP_FOUND`이며 사용자가 복구 포기를 승인했다.
- 신규 빈 database에 현행 migration을 적용했다.
- 신규 리뷰 계정만 생성했다.
- 초기화 직후 암호화 snapshot
  `project-services-postgres-initialized-20260726`을 생성했고 상태는
  `available`이다.
- 신규 초기 상태: `RECOVERABLE`

## 비밀정보 계약

값은 문서나 Git에 기록하지 않는다. 런타임은 다음 이름의 AWS Secrets Manager
항목에서만 주입한다.

- `production/cryptory/database`
- `production/cryptory/runtime`
- `production/cryptory/review-account`

## 현재 차단 항목

1. Firebase Admin 자격증명이 없어 실제 FCM 전달은 미검증이다.
2. 가격 알림 worker는 안전을 위해 비활성 상태다.
3. 설치된 Firebase/Google 의존성 트리에 production advisory가 남아 있다.
4. shared RDS는 `db.t4g.micro`, single-AZ, backup retention 1일이므로 리뷰 및
   초기 검증용이다. 운영 cutover 전 용량·보존·가용성 정책을 승인해야 한다.
5. legacy 오타 호스트 `crytory.duckdns.org`는 현재 DNS/TLS 호환이 없다.

현재 서버는 공개 REST/WSS와 App Review 차단 계약까지 동작하지만, 실제 push
전달과 운영 내구성 게이트가 남아 있으므로 전체 재배포 상태는
`CONDITIONAL_GO`이다.
