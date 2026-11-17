# Yacht Dice 구조 분석 (REA)

대상: `<Steam 라이브러리>/steamapps/common/Yacht Dice/YachtDice_Data/Managed/Assembly-CSharp.dll`
(Unity 2021.3.35f1, Mono, SHA-256 `c68e9f5c…b5e6b6`, MVID `4c193dac-2711-4952-8c6f-0464b9a48830`)

REA `inspect_managed_members`로 IL을 정적으로 디코딩했습니다(게임은 실행하지 않음).

## 구조

| 계층 | 클래스 | 역할 |
|---|---|---|
| 씬/진행 | `SingleGameSceneManagerBase` → `YachtSingleSceneManager` | 상태 머신(`GameState`), `AllRound=13`, 플레이어 목록, `ChangeCurrentPlayer`, AI 생성 |
| 주사위 컵 | `LocalRoller` (`RollerState`: Wait→RollerMoving→DaoChu(붓기)→DiceRolling→DiceMoveToSelect→DiceSelecting→GoBack) | 턴 초기화 `ResetRoller`(`RemainRollTime=3`), `RollerReRoll`, `ConfirmScore`(라운드 > 12면 종료) |
| 주사위 | `LocalDice` (`Rolling/Static/InSelecting/InMoving/InDesk`), `LocalDesk` | 물리 굴림 결과 `GetDiceResult`, 고정(desk) 슬롯 |
| 점수표 | `YachtPlayerScoreBoard` | 족보 12칸 계산·확정, 보너스, 합계, AI 휴리스틱 |
| AI | `AIPlayer` + 코루틴 `<StartSelectDices>d__18` | 매 굴림 후 판단 |
| 기타 | FairyGUI(UI), Mirror/Steamworks(온라인), `UnfinishedManager`(`Unfinished.txt`) | 이 재구현에서는 제외 |

## 점수 규칙 (IL에서 확인)

| idx | 족보 | 점수 | 근거 메서드 |
|---|---|---|---|
| 0–5 | 1~6 | 해당 눈의 합 | `NumberScore` |
| 6 | 초이스 | 주사위 5개 합 | `ChanceRes` |
| 7 | 포 카인드 | 같은 눈이 4개 이상이면 **주사위 5개 전체 합** | `FourSameRes` |
| 8 | 풀 하우스 | 모든 그룹이 3/2개일 때 **고정 25** (요트는 해당 없음) | `FullHouseRes` |
| 9 | 스몰 스트레이트 | 1234/2345/3456 포함 시 30 | `SmStraightRes` |
| 10 | 라지 스트레이트 | 중복 없음, 1과 6이 동시에 있지 않음 → 40 | `LgStraightRes` |
| 11 | 요트 | 5개 모두 같음 → 50 | `Yacht` |
| – | 보너스 | 상단 합 ≥ 63이면 +35 (`{0}/63` 표시) | `CalculateGroundTotal` |

최대 점수 345: IL에 `grand == 345` 검사(업적)가 있어서 위 규칙과 맞는지 교차 확인했습니다.

## AI (`<StartSelectDices>d__18.MoveNext`)

1. 굴린 결과가 풀 하우스·라지 스트레이트·요트(`static int[] {1,3,4}`)면 바로 기록합니다.
2. 굴림이 남았고 스몰 스트레이트인데 라지 스트레이트 칸이 이미 찼으면 스몰 스트레이트를 기록합니다.
3. 마지막 굴림이면 스몰 스트레이트 → 기록합니다. 아니면 다음 가중치로 고릅니다.
   상단 `qian6Add[i] + count*qian6Mul[i]`, 초이스 `합*0.23`, 포 카인드 `점수*0.47`, 그리고 칸별 잔여 가중치
   `[0.1,.09,.08,.07,.02,.01,.01,.05,.04,.02,.03,.03]`.
4. 굴림이 남았으면 `AllScorePrePoints`가 가장 큰 목표를 고르고, `NoMoveDices`에 해당하는 주사위를 고정한 뒤 다시 굴립니다.
   스트레이트를 노릴 때는 눈마다 하나씩만 고정합니다.

## 관찰 vs 추정

- **관찰(IL)**: 위 점수 규칙, 턴당 3굴림, 12라운드, 보너스, AI 분기·가중치 상수.
- **추정**: `{1,3,4}` 배열 값. 해당 필드의 RVA 데이터를 직접 읽지 않고, 어셈블리 안에서 그 바이트 패턴이 한 번만 나오는 것으로 판단했습니다.
- **미확인**: `qian6Add/qian6Mul`은 Unity 프리팹에 직렬화된 값이라 DLL에 없습니다. 재구현에서는 `Add=0`, `Mul=눈 값`으로 정했습니다.
  `AIDifficulty`(Easy/Normal/Hard)가 실제 판단에 어떻게 쓰이는지는 분석 범위 밖이었습니다.
- **재구현 시 바꾼 부분**: 3D 물리 굴림 대신 균등 난수를 씁니다. 원본은 `NoMoveDices`를 매 굴림 초기화하지 않지만, 여기서는 매번 새로 계산합니다.

---

# 멀티플레이 구조

분석한 27개 타입: `MyNetworkManager`, `NetworkManagerHelper`, `NetworkGameSceneManagerBase`, `YachtNetworkSceneManager`,
`MirrorRoller`, `MirrorDice`, `MirrorDesk`, `YachtNetworkPlayer`, `MyNetworkPlayerBase`, 메시지 구조체 4종,
`MainUILobbyManager`, `MainUIMultiplayerManager`, `GameCreateArguments`, `SteamManager`, `Mirror.GeneratedNetworkCode` 등.
REA 증거: 멤버/IL `ev_c6a2202503c39d24…`. 모두 정적 분석이고, 네트워크 트래픽은 캡처하지 않았습니다.

## 계층 구조

```
Steam 로비 (HeathenEngineering LobbyManager)    방 목록, 검색, 메타데이터, 준비, 채팅, 친구 초대
        │  로비 owner가 호스트가 됨
Mirror NetworkManager (MyNetworkManager)        호스트 = 서버 + 클라이언트 ("'s Listen Server")
        │
FizzySteamworks 트랜스포트                       Steam P2P (SteamNetworking) + Steam 릴레이
        │  (Managed/ 폴더에 kcp2k, Telepathy, SimpleWebTransport도 있지만 로그상 쓰이는 건 Steam 쪽)
NetworkBehaviour들                              SyncVar / Command / ClientRpc / NetworkMessage
```

- 로컬 `Player.log`에 `Starting server [DEPRECATED SteamNetworking]. Relay enabled: True`,
  `Starting client … target address <SteamID>`가 찍혀 있습니다. 접속 대상이 IP가 아니라 Steam ID라는 뜻입니다.
- `NetworkManagerHelper`는 Steam Relay 상태(`RelayState`: Ok/Connecting/Failed)와 핑을 관리합니다.

## 로비 (방 만들기/참가)

- `MainUILobbyManager.AddCreateArguments`가 Steam 로비 메타데이터를 설정합니다.
  `GameName`, `TimePerTurn`(PlayerPrefs, **기본 60**), `ThisLobbyName`, `ThisLobbyOwner`(SteamID), `LobbyIsTeam`,
  `UnfinishedTimes`(중도 이탈 횟수), `PingString`, `PlayerSlot`(최대 인원), `CurrentPlayers`.
- 방 찾기(`SearchLobby`, `QuickMatch`), 목록(`MainUIMultiplayerManager.OnLobbyFound`), 필터(`TeamFilters`), 친구 초대.
- **게임 시작** `LobbyStartGame`:
  1. 로비 owner만 시작할 수 있습니다.
  2. 전원 `IsReady`여야 합니다(`CheckAllPlayerReady`).
  3. 개인전은 2명 이상, 팀전은 팀 색이 모두 같으면 안 됩니다.
  4. `ServerChangeScene("NetworkYacht")` 후 `Lobby.SetJoinable(false)`로 난입을 막습니다.
- 팀 모드: `LobbyTeamColor` Blue/Green/Orange/Purple, `LobbyPerTeamNumbers`.

## 게임 중 동기화 (서버 권한형)

| 방향 | 종류 | 멤버 | 내용 |
|---|---|---|---|
| C→S | Command | `YachtNetworkPlayer.RollerController(ControlName, bool, ulong)` | 흔들기/굴리기/붓기/다시 굴리기 |
| C→S | Command | `YachtNetworkPlayer.MoveDice(MirrorDice)` | 주사위 고정·해제 |
| C→S | Command | `AddThisPlayerToServer`, `SetPlayerNameAndID` | 입장 등록 |
| C↔S | NetworkMessage | `ScoreMessage{CSteamID, ConfirmIndex}` | 점수 칸 확정 |
| C↔S | NetworkMessage | `ShowPopMessage{CSteamID, PopType(ScoreBoard/Select/Desk), Index, Open}` | 현재 플레이어가 보고 있는 칸 공유 |
| C↔S | NetworkMessage | `EmojiMessage{CSteamID, EmojiIndex}` | 이모지 |
| S→C | SyncVar | `MirrorRoller.controllerId, round, state, remainRollTime, remainControllTime` | 현재 턴 소유자, 라운드, 남은 굴림, 남은 시간 |
| S→C | SyncVar | `MirrorDice.state, targetPosition, targetRotation, diceInDeskIndex` | 주사위 위치·상태 (물리는 서버에서) |
| S→C | SyncList/Dict | `allPlayerSteamID`, `allConfirmLobbySteamID`, `MirrorDesk.dices`, `deskDiceDictionaty` | 참가자, 고정된 주사위 |
| S→C | ClientRpc | `RpcClientHandleRandom(int)` | 시작할 때 시드(`UtcNow.Ticks + frameCount`)를 모두에게 배포 |
| S→C | ClientRpc | `RpcShowPlayerScore`, `RpcSetOffline`, `ShowScore` | 점수 미리보기, 오프라인 표시, 결과 |

- **턴 검증**: `MirrorRoller.RollDice(id, …)`는 `controllerId == id`이고 `state == Wait`일 때만 실행됩니다.
  주사위 물리와 결과는 호스트에서 계산합니다.
- **턴 순서** `YachtNetworkSceneManager.ChangeCurrentPlayer`: `CurrentPlayerIndex`(SyncVar)가 `allConfirmLobbySteamID`를 순환합니다.
  `scoredTime % 인원 == 0`이면 `round++`, `round == 13`이면 `End`.
- **턴 제한 시간**: `remainControllTime`가 카운트다운하고, 시간이 다 되면 `MirrorRoller.AutoScore()`가 실행됩니다.
  `AutoScore`는 `GetFirstUnConfirmButton()`으로 **첫 번째 빈 칸**을 골라 `ScoreMessage`로 확정합니다.
- **이탈 처리** `YachtNetworkSceneManager.OnLobbyUserLeave` (게임 중일 때):
  1. 점수표를 `SetPlayerScoreOffline`으로 표시합니다.
  2. 로비 인원이 1명이면 `End`로 갑니다.
  3. 나간 사람이 현재 턴이면 `AutoScore`를 실행합니다.
  4. 준비 단계(`Prepare`)였다면 목록에서 제거합니다.
- **방장 이탈**: 호스트가 곧 서버라서 호스트가 나가면 클라이언트는 `Server Disconnected`로 끊깁니다(Mirror listen server의 한계).

## 웹 버전에 옮긴 방식

| 원본 | 웹 버전 (`server.js`) |
|---|---|
| Steam 로비 + 메타데이터 | 메모리 방 목록, 4자리 방 코드, 방 이름, 턴 제한 시간(0/30/**60**/90초) |
| 로비 owner만 시작, 전원 준비, 2명 이상 | 동일 (최대 4명) |
| Mirror Command (클라→서버 입력) | WebSocket JSON `roll` / `hold` / `score` |
| SyncVar/ClientRpc (서버→클라 상태) | 액션마다 방 전체 상태(`room`)를 브로드캐스트 |
| `controllerId == sender` 검사 | 현재 플레이어가 아닌 입력은 거부 |
| 호스트에서 물리 굴림 + 시드 배포 | 서버에서 `crypto.randomInt`로 굴림 (클라이언트는 결과만 받음) |
| `AutoScore` (시간 초과·이탈) | 동일: 첫 번째 빈 칸에 자동 기록 |
| 1명만 남으면 종료 | 동일 |
| `EmojiMessage` | `emoji` 메시지 (6종, 0.8초 간격 제한) |
| 호스트 = 서버 | **독립 서버**라 방장이 나가도 게임이 계속되고, 방장 권한은 다음 사람에게 넘어갑니다 |
| — | 끊긴 뒤 같은 브라우저 탭으로 다시 접속하면 자리를 복구합니다(토큰) |

**옮기지 않은 것**: 팀 모드, 빠른 매칭, 채팅, 친구 초대, 핑 표시, `ShowPopMessage`(다른 사람이 보고 있는 칸 공유), 3D 주사위 물리.
**미확인**: `PlayerSlot` 최대값(콤보박스 항목은 UI 패키지에 있어 DLL에서 확인하지 못함). 웹 버전은 팀 색 수에 맞춰 4명으로 정했습니다.

---

# 메인 화면: 설정, 친구, 전적

분석한 타입은 아래와 같습니다. REA 증거: `ev_b42a2002998c4aa5…`.
- `MainPanel`, `MainUIHomeManager`, `UISetting`, `SettingArguments`, `AudioManager`, `KeyBindingManager`
- `MainUIFriendsManager`, `RichPresenceClass`, `MainUIState`, `MySteamAchievement`
- `ColorModifyHelper`, `SimpleLUTSave`, `NoticeManager`, `TranslateHelper`

## 메인 화면 버튼 (`MainPanel`, `MainUIHomeManager`)

- **홈**: `Btn_SingleGame`, `Btn_LocalGame`, `Btn_OnlineGame`, `Btn_QuickMatch`
- **상단**: `Btn_Setting`(설정), `Btn_Trigger`(친구창 토글), `Btn_State`(전적), `Btn_Help`(조작 도움말 영상, `ControllerHelper`), `Btn_Exit`
- **알림창** `NoticeManager`: 버튼 1개짜리 창, 버튼 2개짜리 창, 상태 창

## 설정 (`UISetting` + `SettingArguments` = PlayerPrefs 키)

| 항목 | UI 이름 | 저장 키 / 기본값 |
|---|---|---|
| 언어 | `CB_Language` | `LanguageHSelectorValue`. `TranslateHelper`가 English / 中文 / Deutsch / 한국어를 Steam 언어로 자동 선택 |
| 볼륨 4종 | `Sli_MasterVolume`, `Sli_MusicVolume`, `Sli_SFXVolume`, `Sli_EffectsVolume` | `master/music/SFX/EffectsVolumeSliderValue`, **기본 40** |
| 볼륨 적용 | `AudioManager.ChangeVolume` | Master·Effects는 믹서 dB `lerp(-33, 7, v/100)`, Music은 BGM 볼륨 `v/100`, SFX는 Interface 그룹 |
| 해상도 / 창 모드 | `CB_Resolution`, `CB_WindowMode` | `resolutionComboBox(2)`, `windowModeComboBox` |
| 그래픽 / 프레임 / 수직동기 | `CB_GraphicsPreset`, `CB_FrameRate`, `CB_V Sync` | 기본 4 / 1 / 0 |
| 색 보정(LUT) | `Sli_Saturation/Brightness/Contrast/Sharpness/BloomVolume` | `LUT_*`, 저장 범위 −1..1, 기본 0 |
| 키 설정 | `Key_RollDice`, `Key_PourOut`, `Key_Reselect`, `Key_StopRoll` | `KeyBindingManager`(`KeyAction` enum 12개) |
| 컨트롤러 속도 | `Sli_ControllerMoveSpeed` | `ControllerSpeed` |
| 도움말 표시 | — | `TipVisible`, `OpenMouseTip`, `OpenTriggerTip` |
| 초기화 | `Btn_Reset` | `ResetAllValue` |
| 꾸미기 | `ColorModifyHelper` | 테이블 안/밖, 주사위 안/밖, 컵 안/밖 색(`WMaterialType`), 주사위 모델(구형/신형, `DiceModelType`) |

## 친구 (`MainUIFriendsManager`)

- 목록은 `FriendManager.GetFriends`(Steam 친구)에서 가져옵니다.
- **정렬** `SortFriendsData`: 접속 중(`State != Offline`)인 친구를 앞으로 보냅니다.
- **검색** `SearchFriends`: 이름을 소문자로 바꿔 부분 일치로 찾습니다. 검색하면 1페이지로 돌아갑니다.
- **페이지** `ChangeFriendPage`: `{현재}/{전체}` 형식, 한 페이지 인원(`friendsEachPage`)은 인스펙터 값이라 미확인입니다.
- **상태 표시**: `RichPresenceClass`(`ThisGameState` 키)와 `ChangeGTextRich`가 담당합니다.
  - 오프라인: 회색
  - 게임 밖: 접속 중
  - `In The Game`: 초록
  - `In The Lobby`: 자홍
  - `In Gaming`: 빨강
- **버튼**:
  - `Btn_Invite`: 내 로비로 초대
  - `Btn_Join`: 친구가 있는 로비에 참가. 친구가 로비에 있을 때만 활성화됩니다.

## 전적, 업적 (`MainUIState`, `MySteamAchievement`)

- **Steam 통계**: `stat_Win_Numbers`, `stat_GET_Yacht`
- **전적창**: 승리 수와 요트 횟수를 막대로 보여 줍니다(최대 100에서 잘림).
- **업적 6종**:

| 업적 ID | 조건 |
|---|---|
| `WON_ONE_GAME_ACH` | 1승 |
| `WON_100_GAME_ACH` | 100승 |
| `YACHT_ACH` | 요트 1회 |
| `50_YACHT_ACH` | 요트 50회 |
| `345_SCORE_ACH` | 345점 (`CalculateGroundTotal`의 345 검사) |
| `PLAY_WITH_FRIEND` | 로비에 Steam 친구가 있으면 달성 (`HasFriend`) |

## 웹 버전에 옮긴 방식

| 원본 | 웹 버전 |
|---|---|
| 언어 4종 | 한국어 / English (`i18n.js`). 표를 추가하면 언어를 늘릴 수 있습니다 |
| 볼륨 4종, 기본 40 | 전체 / 배경음악 / 인터페이스 / 효과음, 기본 40, 음소거. 소리는 Web Audio로 합성합니다 |
| BGM Main / Yacht | 메인 화면용, 게임 중용 루프 2종 |
| 타이머 똑딱 소리, 승리/패배 소리 | 내 턴 마지막 5초 똑딱, 승리/패배 소리 |
| 해상도, 창 모드, 그래픽, 프레임, 수직동기 | 웹에는 없는 개념이라 **테마(시스템/밝게/어둡게)**와 **애니메이션 줄이기**로 대체 |
| LUT 색 보정 | 밝기 / 채도 / 대비 (CSS 필터). 선명도와 블룸은 제외 |
| 키 설정 4종 | 굴리기, 모두 해제(=Reselect), 1~5번 주사위 고정. 키가 겹치면 서로 바꿉니다. 붓기와 멈추기는 3D 물리가 없어 제외 |
| 도움말 표시 | 도움말 문구 표시 켜기/끄기 |
| 색 꾸미기 | 테이블, 주사위, 눈, 1·4 눈 색 |
| Steam 친구 | **친구 코드**(6자리). 브라우저에 저장한 비밀 키에서 서버가 만듭니다. 코드로 추가하거나 "접속 중인 사람" 탭에서 추가 |
| Rich Presence | 오프라인 / 접속 중 / 대기실(방 이름) / 게임 중 |
| 정렬, 검색, 페이지 | 동일 (접속자 우선, 이름·코드 검색, 8명씩) |
| 초대 / 참가 | 동일. 초대는 알림 카드와 친구 버튼의 빨간 배지로 받습니다 |
| Steam 통계, 업적 | 브라우저 `localStorage`에 저장. 같은 업적 ID와 조건 |
| 빠른 매칭 | 사람이 가장 많은 열린 방에 참가하고, 없으면 새로 만듭니다 |
| 도움말 영상 | 규칙표와 현재 키 설정을 보여 주는 도움말 창 |

**바꾼 점**: 원본에 없는 "0점 기록 전에 확인" 옵션을 추가했습니다.

**옮기지 않은 것**: 해상도·그래픽 품질, 선명도·블룸, 컨트롤러 속도, 주사위 3D 모델 선택, Steam 아바타.
