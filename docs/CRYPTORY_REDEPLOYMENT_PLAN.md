# Cryptory redeployment plan

## 현재 완료 지점

1. 새 AWS 계정의 EC2, Elastic IP, 보안 그룹과 SSM 구성
2. private RDS에 서비스 전용 database/role 생성
3. Prisma migration 11/11 적용
4. 전용 Redis, PM2, Nginx, HTTPS와 WSS 구성
5. App Review mode 및 거래성 endpoint 차단 검증
6. 리뷰 계정 생성과 REST 로그인 검증
7. 초기화 직후 암호화 RDS snapshot 생성
8. Firebase Admin project `cryptory-342cf` 운영 초기화
9. 가격 알림 worker 활성화와 synthetic FCM token 등록·삭제 검증

## 남은 순서

1. 실제 TestFlight 기기 token으로 FCM 전달과 가격 알림 deep link 검증
2. 앱의 legal/support URL이 공개 200 페이지와 일치하는지 Release에서 검증
3. 서명된 iOS Release archive와 production push entitlement 검증
4. TestFlight에서 리뷰 계정 로그인, token refresh, WSS reconnect, 가격 알림
   deep link 회귀 검증
5. 최소 24시간 health/readiness, PM2 restart count, DB connection, Redis,
   WebSocket reconnect, FCM 오류를 관찰
6. 별도 승인 후 App Store 제출

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
