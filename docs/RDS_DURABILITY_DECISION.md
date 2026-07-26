# Cryptory RDS durability decision

결정일: 2026-07-26

## 현재 승인 범위

사용자는 신규 AWS 계정의 무료 플랜을 우선 사용하고, 기존 운영 데이터 복구를
포기했으며, 하나의 RDS 인스턴스에 서비스별 database와 role을 분리하는 구성을
승인했다.

현재 shared RDS의 `db.t4g.micro`, single-AZ, backup retention 1일 구성은
리뷰 계정, TestFlight, 초기 기능 검증에 한해 수용한다. 이 구성은 일반 사용자
운영 내구성을 충족한다고 간주하지 않는다.

## 운영 cutover 게이트

일반 사용자 운영을 시작하기 전 다음 중 하나를 명시적으로 승인해야 한다.

1. 권장: 유료 Multi-AZ, backup retention 7일 이상, deletion protection,
   암호화 snapshot과 복구 rehearsal.
2. 비용 우선: single-AZ를 유지하되 backup retention 7일 이상, 매일 logical
   backup의 다른 저장소 복제, 정기 복구 rehearsal, 장애 시간 수용 확인.

어느 방식을 선택하더라도 cutover 직전 수동 snapshot, migration rehearsal,
storage/connection alarm, rollback 기준을 확인한다. 비밀값과 연결 문자열은
문서에 기록하지 않는다.

현재 판정은 `REVIEW_AND_TESTFLIGHT_ACCEPTED`, 일반 사용자 운영은
`DURABILITY_DECISION_REQUIRED`이다.
