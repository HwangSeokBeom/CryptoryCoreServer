# Cryptory server redeployment readiness

검증 기준일: 2026-07-26
상태: `PUBLIC_RUNTIME_READY_WITH_BLOCKERS`

## 운영 문서

SSM 접속, 상태 확인, PM2/Nginx/Redis 로그, 안전한 재시작, 장애 대응 및
후속 배포 절차는 [OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md)에 정리했다.
RDS 단계별 내구성 결정은
[RDS_DURABILITY_DECISION.md](./RDS_DURABILITY_DECISION.md)에 정리했다.

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
- 2026-07-26 외부 HTTPS에서 리뷰 계정 로그인, FCM token 등록·삭제 재검증
- Firebase Admin이 project `cryptory-342cf`로 초기화됨
- `FCM_ENABLED=true`, `FCM_DRY_RUN=false`, 가격 알림 worker 활성화
- worker가 빈 활성 알림 집합에서 정상 tick하며 REST readiness를 유지
- App Review configuration
- 신규/legacy 주문 및 거래 endpoint가 외부 HTTPS에서 모두 `403`으로 차단
- 외부에 3000, 3002, 5432, 6379가 노출되지 않음
- 서비스 IAM role이 자기 서비스 secret만 읽고 다른 서비스 secret은 거부
- CloudWatch Agent가 PM2/Nginx 로그와 memory/root-disk 지표를 수집
- EC2 status/CPU와 shared RDS CPU/storage/connection alarm 생성
- 15개 공통 alarm의 `ALARM`/`OK` action을 SNS topic
  `project-services-ops-alerts`에 연결

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

1. 실제 APNs/FCM 기기 토큰으로 전달과 가격 알림 deep link를 검증하지 않았다.
   서버 초기화와 synthetic token 등록·삭제는 실제 기기 전달의 증거가 아니다.
2. FCM HTTP v1 전환과 dependency-security 수정은 readiness 브랜치에 병합됐다.
   production audit 0건, tests 378/378이 통과했고 실제 운영 Firebase
   자격증명으로 OAuth와 validate-only 요청이 Firebase API까지 도달했다.
   synthetic invalid token을 사용해 실제 알림은 전달하지 않았으며, 이 코드는
   현재 공개 EC2에 아직 배치하지 않았다.
3. shared RDS는 `db.t4g.micro`, single-AZ, backup retention 1일이므로 리뷰 및
   초기 검증용이다. Free Tier 계정이 retention 7일 변경을 거부했으므로 운영
   cutover 전 유료 플랜과 용량·보존·가용성 정책을 승인해야 한다.
4. legacy 오타 호스트 `crytory.duckdns.org`는 현재 DNS/TLS 호환이 없다.
5. CloudWatch alarm 이메일 구독은 2026-07-26 확인 완료됐다. AWS가 구체적인
   subscription ARN을 반환하므로 실제 알림 전달 경로가 활성 상태다.

현재 서버는 공개 REST/WSS, App Review 차단, Firebase 초기화와 가격 알림
worker까지 동작한다. 보안 수정은 배포 준비가 됐지만 실제 기기 push 전달과
운영 내구성 게이트가 남아 있으므로 전체 재배포 상태는
`CONDITIONAL_GO_AFTER_SECURITY_ARTIFACT_DEPLOYMENT`이다.
