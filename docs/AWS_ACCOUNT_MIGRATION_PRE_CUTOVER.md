# AWS 계정 이전 사전 준비

이 문서는 새 AWS 계정으로 Cryptory 서버를 옮기기 직전까지의 절차를 정의한다. 실제 운영 DB 변경, DNS 전환, PM2 재시작과 배포는 별도 승인이 있기 전에는 수행하지 않는다.

## 고정 계약

- Node.js: 22 이상
- 애플리케이션 포트: 3000
- PM2 앱 이름: `cryptory-core-server`
- 기본 설치 경로: `/home/ec2-user/CryptoryCoreServer`
- liveness: `/health`
- readiness: `/ready`
- public WebSocket: `/ws/market`
- private WebSocket: `/ws/trading`

## 기존 계정에서 읽기 전용으로 확보할 목록

- AWS account ID와 region
- EC2 instance ID, AMI, instance type, availability zone
- Elastic IP와 ENI
- Security Group inbound/outbound 규칙
- EBS volume ID, 암호화 상태, snapshot ID
- RDS를 사용한다면 instance/cluster ID, subnet/security group, automated backup
- EC2-local PostgreSQL이라면 data directory, version, service name과 논리 dump
- Redis/ElastiCache endpoint 종류와 persistence 정책
- S3 backup bucket과 object version
- SSM Parameter/Secrets Manager의 **이름만**
- CloudWatch log group/alarm 이름
- 현재 PM2 process description과 reverse proxy 설정

비밀값과 PEM 본문은 문서나 채팅에 기록하지 않는다.

## 백업 게이트

다음 증거가 없으면 이전하지 않는다.

1. 전환 직전 PostgreSQL 논리 백업
2. EBS/RDS snapshot
3. 백업 생성시각, 크기, 암호화 상태
4. 격리된 환경에서의 복원 성공
5. 복원 DB에 대한 `prisma migrate deploy` 성공
6. 핵심 테이블 row-count와 관계 검증

## 새 계정 사전 준비

1. 기존 region과 동일하거나 규제/latency 요구를 충족하는 region을 선택한다.
2. VPC, public/private subnet, route, NAT/IGW를 준비한다.
3. 애플리케이션과 DB/Redis 보안 그룹을 분리한다.
4. SSH 대신 SSM Session Manager를 우선한다.
5. EBS, RDS, S3, Secrets Manager를 KMS로 암호화한다.
6. CloudWatch log/metric/alarm을 먼저 만든다.
7. Node 22, Nginx, PM2 또는 승인된 container runtime을 설치한다.
8. 소스와 build artifact를 고정 SHA로 배치하되 시작하지 않는다.
9. 운영 env는 secret store에서 주입하고 `.env`를 source control에 넣지 않는다.
10. `npm ci`, `npm run build`, `scripts/precutover-check.sh`를 실행한다.

## DB migration rehearsal

운영 DB가 아닌 격리 복제본에서만 수행한다.

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npm test
```

`prisma db push`, `_prisma_migrations` 수동 편집 또는 production baseline 강제 지정으로 실패를 우회하지 않는다.

## 서버 시작 전 검증

- `deploy/ecosystem.config.cjs`의 cwd 확인
- `PORT=3000`
- Nginx upstream `127.0.0.1:3000`
- WebSocket Upgrade/Connection header
- `/health`는 process liveness
- `/ready`는 PostgreSQL과 Redis가 모두 정상일 때만 200
- `APP_STORE_REVIEW_MODE=true`
- FCM은 최초에 `FCM_DRY_RUN=true`
- price alert worker는 DB/FCM 검증 전에는 비활성화

## Cutover 직전 중단점

다음 명령은 아직 실행하지 않는다.

- 운영 `prisma migrate deploy`
- `pm2 start`, `pm2 restart`, `pm2 reload`
- Nginx reload
- Elastic IP 연결/이전
- DuckDNS 변경
- Route 53 변경
- TestFlight/App Store 업로드

이 시점에서 배포 승인자는 백업, 복원 rehearsal, rollback owner, 관찰 지표와 전환 창을 확인해야 한다.
