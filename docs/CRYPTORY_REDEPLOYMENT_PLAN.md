# Cryptory redeployment plan

## 현재 완료 지점

1. 새 AWS 계정의 EC2, Elastic IP, 보안 그룹과 SSM 구성
2. private RDS에 서비스 전용 database/role 생성
3. Prisma migration 11/11 적용
4. 전용 Redis, PM2, Nginx, HTTPS와 WSS 구성
5. App Review mode 및 거래성 endpoint 차단 검증
6. 리뷰 계정 생성과 REST 로그인 검증
7. 초기화 직후 암호화 RDS snapshot 생성

## 남은 순서

1. Firebase Admin 자격증명을 `production/cryptory/runtime`에 안전하게 주입
2. FCM dry-run 해제 전 테스트 token 한 개로 실제 전달 검증
3. price alert worker를 제한적으로 활성화하고 생성·전달·삭제 확인
4. 앱의 legal/support placeholder 제거
5. 서명된 iOS Release archive와 production push entitlement 검증
6. TestFlight에서 리뷰 계정 로그인, token refresh, WSS reconnect, 가격 알림
   deep link 회귀 검증
7. 최소 24시간 health/readiness, PM2 restart count, DB connection, Redis,
   WebSocket reconnect, FCM 오류를 관찰
8. 별도 승인 후 App Store 제출

## 운영 cutover 게이트

- RDS class, backup retention, deletion protection, Multi-AZ 여부 승인
- CloudWatch application/Nginx/PM2/RDS alarms
- 실제 Firebase/APNs 전달
- rollback owner와 snapshot 복원 절차
- canonical DNS와 legacy client 호환 정책
- dependency security 검토

롤백은 DNS를 임의 변경하는 방식이 아니라, 직전 검증 artifact와 암호화 snapshot
복원을 기준으로 수행한다. 현재 단계에서 TestFlight/App Store 업로드는 승인되지
않았다.
