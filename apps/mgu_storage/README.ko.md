# Storage (mgu_storage)

MGU(헤드유닛)가 얼마나 차 있는지 보는 앱입니다. 읽기만 하고, 아무것도 지우거나 바꾸지 않습니다.

## 화면

| 페이지 | 내용 |
|---|---|
| Disks | MGU의 파일 시스템별 남은 공간 / 사용량 / 전체 크기와 사용률 막대(75% 주황, 90% 빨강). 앱이 설치되는 파티션에 `APPS` 표시, 읽기 전용 시스템 파티션에 `READ-ONLY` 표시. 오른쪽에 앱용 남은 공간과 메모리(RAM) 사용량, MGU 켜진 시간 |
| Apps | **Storage helper가 설치돼 있으면:** 왼쪽 `BMW apps`(순정 앱과 앱 플랫폼 MainApp), 오른쪽 `Custom apps`(사제 앱)로 나눠 앱마다 용량과 합계를 표시하고, 사제 앱 아래에 `/var/opt`의 사제 도구 폴더(Store, 렌더러, cluster-render 등)와 그 합계를 표시. 아래에 마지막 측정 시각. `Refresh`를 누르면 helper가 5초 안에 다시 잼.<br>**helper가 없으면:** 이 앱 자기 폴더만 재고, 나머지는 `no access`와 helper 설치 안내 |

버튼: `Refresh`(다시 읽기), `Next page`, `Settings`.

설정: 시작 페이지, RAM 디스크(tmpfs) 표시, 읽기 전용 파티션 표시, 용량 단위(1024 / 1000), 테마, 화면 레이아웃, 렌더러.

## 동작 방식

- 파일 시스템 용량: MGU의 Node.js 8에는 디스크 용량을 읽는 함수가 없어서, MGU에 있는 `df -k` 명령을 실행해서 읽습니다(화면이 떠 있을 때 10초마다).
- 메모리: `/proc/meminfo`, 켜진 시간: `/proc/uptime`
- 앱 용량: 각 앱 폴더를 훑어서 실제 디스크 사용량(du와 같은 방식)을 더합니다. 앱 이름은 `oap_12201/security/uids.txt`와 각 앱의 `package.json`에서 읽습니다.
- **Storage helper (`kit/storage-helper`):** MGU에서는 앱마다 자기 리눅스 계정으로 실행되고 앱 폴더 권한이 750이라, 앱은 자기 폴더만 잴 수 있습니다. 그래서 root로 도는 작은 서비스(Storage helper)를 MGU Store의 도구로 따로 설치합니다. helper는 `du`로 앱 폴더마다 용량을 재서 `/run/mgu-storage/apps.json`에 씁니다.
  - 어떤 앱인지: `oap_12201/security/uids.txt`(`uid=앱ID`), 이름은 앱의 `app-spec.json` 제목이나 `package.json`
  - 순정/사제 구분: `oap_12201/data/custom_apps.json`에 있으면 사제(이 저장소 설치기와 MGU Store가 여기에 등록), `oap_12201`은 앱 플랫폼, 나머지는 순정
  - 시동 후 한 번, 30분마다, Refresh 요청 시(`/dev/shm/mgu-storage-request`) 잽니다. 읽기만 하고, CPU·디스크 우선순위를 가장 낮게 둡니다.
- Disks 페이지(`df`)와 메모리는 helper 없이 동작합니다.

## 차에서 처음 확인할 것

Disks 페이지에 `df: ...` 오류가 보이면, 앱 권한으로 `df` 명령을 실행하지 못한 것입니다. 앱 로그를 보내주세요:

```cmd
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -i C:\BMW\idrive7-8-ssh-root-main\data\enrollments\<VIN>\id_rsa root@<MGU IP> "tail -30 /var/opt/public/oap/oap_*/data/mgu_storage.log"
```

`<VIN>`과 `<MGU IP>`는 자기 차의 값으로 바꿔 넣으세요. 정상이면 로그에 `file systems (df -kP): ...`와 `app folders: N in ... ms`가 남습니다.

## 변경 이력

- 1.1.0: Storage helper(Store 도구)와 함께 순정 앱과 사제 앱을 나눠 앱별 용량과 합계, 사제 도구 폴더 용량 표시. Refresh가 helper에 다시 재기를 요청.
- 1.0.1: 다른 앱 폴더처럼 열 수 없는 폴더를 `0 KB *` 대신 `no access`로 표시하고 맨 아래로 정렬, 이유를 화면 아래에 표시. Store 목록용 아이콘(`icon.png`) 추가. 테스트 `kit/tools/test_mgu_storage.js` 추가.
- 1.0.0: 처음 버전.
