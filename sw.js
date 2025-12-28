// Service Worker의 이름은 이 시스템의 버전 관리를 위해 중요하다!
const CACHE_NAME = 'examflow-cache-v1.0.0';
const STATIC_ASSETS = [
  './', // index.html (루트 경로)
  './index.html',
  './favicon.ico', // 파비콘 경로도 캐싱 대상에 포함시켜라.
  // 나중에 CSS, JS, 이미지 파일 등을 추가한다면 여기에 캐싱 목록에 추가해라.
];

// 이 변수들은 메인 스크립트에서 받아올 데이터다.
let currentExams = [];
let currentLang = 'ko';
let currentPalette = [];
let currentColors = {}; // 과목별 색상 할당을 Service Worker 내부에서도 관리한다.

const T_SW = { // Service Worker 전용 다국어 텍스트. 최소한의 알림 메시지만 포함.
  ko: {
    today_exam: (subject) => `${subject} 시험이 오늘이다! 박살내버려!`,
    upcoming_exam: (subject, days) => `${subject} 시험 D-${days} 남았다! 긴장의 끈을 놓지 마!`,
  },
  en: {
    today_exam: (subject) => `${subject} exam is today! Crush it!`,
    upcoming_exam: (subject, days) => `${subject} exam in D-${days} days! Don't let your guard down!`,
  },
  jp: {
    today_exam: (subject) => `${subject}試験が今日です！粉砕しろ！`,
    upcoming_exam: (subject, days) => `${subject}試験D-${days}日残っています！気を抜くな！`,
  },
  cn: {
    today_exam: (subject) => `${subject}考试就是今天！摧毁它！`,
    upcoming_exam: (subject, days) => `${subject}考试还有D-${days}天！不要放松警惕！`,
  },
  es: {
    today_exam: (subject) => `¡El examen de ${subject} es hoy! ¡Aplástalo!`,
    upcoming_exam: (subject, days) => `¡Faltan D-${days} días para el examen de ${subject}! ¡No bajes la guardia!`,
  }
};


// Service Worker가 설치될 때. 네 병사들이 처음으로 땅을 밟는 순간이다.
self.addEventListener('install', (event) => {
  console.log('Service Worker 설치 중...', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('정적 자산 캐싱 완료!');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting()) // 설치 후 바로 활성화 대기하지 않고 활성화 시키겠다!
      .catch((error) => console.error('캐싱 실패:', error))
  );
});

// Service Worker가 활성화될 때. 낡은 병사들을 정리하고 새로운 병사들을 배치한다.
self.addEventListener('activate', (event) => {
  console.log('Service Worker 활성화 중...', CACHE_NAME);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('오래된 캐시 제거 중:', cacheName);
            return caches.delete(cacheName);
          }
          return Promise.resolve();
        })
      );
    }).then(() => {
      console.log('캐시 정리 완료. Service Worker 제어권 획득!');
      return self.clients.claim(); // 클라이언트 (웹 페이지)의 제어권을 즉시 획득한다.
    })
  );
});

// 네트워크 요청을 가로챌 때. 모든 통신은 내 검열을 거쳐야 한다.
self.addEventListener('fetch', (event) => {
  // 현재는 오프라인 지원을 위한 캐싱 전략이 핵심이 아니므로, 기본적인 캐시-우선 전략만 사용.
  // (나중에 네놈의 앱이 더 거대해지면 다른 전략도 고려해라.)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});

// 메인 스크립트로부터 메시지를 받을 때. 이것이 바로 명령 수신 채널이다.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_NOTIFICATIONS') {
    console.log('Service Worker: 시험 데이터 수신 완료!', event.data);
    currentExams = event.data.exams || [];
    currentLang = event.data.lang || 'ko';
    currentPalette = event.data.palette || [];
    // 과목별 색상 할당 로직도 여기서 다시 실행하여 currentColors를 채운다.
    currentExams.forEach(exam => {
        if (!currentColors[exam.subject]) {
            currentColors[exam.subject] = currentPalette[Object.keys(currentColors).length % currentPalette.length];
        }
    });
    
    // 데이터를 받으면 바로 알림을 스케줄링/확인한다.
    checkAndSendNotificationsSW();
  }
});

// 알림을 클릭했을 때. 사용자 상호작용은 놓치지 않는다.
self.addEventListener('notificationclick', (event) => {
  console.log('알림 클릭됨:', event.notification.tag);
  event.notification.close(); // 알림 창을 닫는다.

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      // 이미 열려있는 ExamFlow 탭이 있다면 그 탭으로 포커스한다.
      for (const client of clientList) {
        if (client.url.includes('/index.html') && 'focus' in client) { // URL을 네 앱의 실제 경로로 변경해라.
          return client.focus();
        }
      }
      // 열려있는 탭이 없으면 새로운 탭을 연다.
      if (clients.openWindow) {
        return clients.openWindow('/index.html'); // URL을 네 앱의 실제 경로로 변경해라.
      }
    })
  );
});


// === Service Worker 내부 알림 로직 ===
// 이 부분은 브라우저가 실행 중이면 (탭이 닫혀있어도) 백그라운드에서 동작할 수 있다.
// LocalStorage를 직접 접근할 수 없으므로, 메인 스크립트에서 받아온 `currentExams` 데이터를 사용한다.

// 알림 고유 ID를 생성한다.
function getNotificationTag(exam, diffDays) {
    return `${exam.title}-${exam.start}-D${diffDays}`;
}

// Service Worker 내부에서 알림을 보낸다.
async function sendNotificationSW(examTitle, subject, diffDays) {
  const bodyMessage = diffDays === 0
    ? T_SW[currentLang].today_exam(subject)
    : T_SW[currentLang].upcoming_exam(subject, diffDays);

  await self.registration.showNotification(examTitle, {
    body: bodyMessage,
    icon: './favicon.ico', // Service Worker 내부 경로는 상대 경로를 사용한다.
    tag: getNotificationTag({title: examTitle, start: ''}, diffDays), // 알림 그룹화를 위한 태그.
    data: {
      examTitle: examTitle,
      subject: subject,
      diffDays: diffDays
    }
  });
  console.log(`SW 알림 전송: ${examTitle} (D-${diffDays})`);
}

// Service Worker 내부에서 시험 일정을 확인하고 알림을 스케줄링/전송한다.
async function checkAndSendNotificationsSW() {
    if (Notification.permission !== "granted") {
        console.log("SW: 알림 권한이 없어 브라우저 알림을 보낼 수 없다.");
        return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayString = today.toISOString().split('T')[0];

    // Service Worker는 LocalStorage에 직접 접근할 수 없으므로, IndexedDB를 사용해야 한다.
    // 하지만 단순화를 위해, 여기서는 "sentNotifications" 로직을 Service Worker 내부의 `caches`에 저장하는 방식으로 구현.
    // 아니면 메인 스크립트에서 이 데이터를 받아서 SW에게 넘겨주는 방식도 가능.
    // (여기서는 `postMessage`로 받는 `currentExams` 데이터를 사용한다.)

    // 실제로는 IndexedDB를 사용하여 Service Worker와 메인 스크립트가 공유하는 데이터를 관리하는 것이 좋다.
    // 하지만 지금은 "sentNotifications"의 동기화를 복잡하게 만들지 않고, 
    // Service Worker가 매번 데이터를 받을 때마다 "현재 보내야 할 알림"을 다시 평가하는 방식으로 간다.
    // 이는 매번 메인 스크립트에서 SW로 데이터가 전송되어야 함을 의미한다.

    // 대신, Service Worker는 자체적으로 "보낸 알림" 목록을 관리해야 한다.
    // SW 내부의 변수는 SW가 재시작되면 초기화될 수 있으므로, 
    // Service Worker도 IndexedDB나 Cache Storage에 `sentNotifications`를 저장하는 것이 안정적이다.

    // 간단화를 위해 여기서는 "한 번 보내면 끝"이라는 가정 하에 현재 브라우저의 notification.getNotifications()를 통해
    // 이미 같은 알림이 있는지 확인하는 방식을 사용한다. (하지만 완벽하진 않음)
    
    // 주기적인 알림 확인을 위한 `setInterval` 또는 `setTimeout`은 Service Worker 내부에서
    // 보장된 백그라운드 실행을 보장하지 않는다. (브라우저가 SW를 종료시킬 수 있기 때문)
    // 따라서, 메인 스크립트에서 데이터가 변경될 때마다 `SCHEDULE_NOTIFICATIONS` 메시지를 보내는 방식이 가장 현실적이다.
    // 또는 `PeriodicSyncManager` API를 사용하여 브라우저가 SW를 주기적으로 깨울 수 있지만, 지원 범위가 제한적이다.

    // 현재는 "메인 앱에서 데이터를 받으면 그 시점에 알림을 보낸다" 로직으로 간다.
    // 사용자에게 즉각적인 피드백을 주기 위함이다.

    // 이미 전송된 알림인지 확인하기 위한 간이 저장소 (Service Worker가 재시작되면 사라짐)
    let swSentNotifications = JSON.parse(await caches.match('sent-notifications')
        .then(response => response ? response.text() : '{}')
        .catch(() => '{}')) || {};
    
    // 오늘 날짜가 아니면 이전 알림 기록을 삭제
    if (swSentNotifications.date !== todayString) {
        swSentNotifications = { date: todayString, exams: {} };
        console.log("SW: 이전 알림 기록 초기화됨.");
    }
    const currentSentExams = swSentNotifications.exams;

    currentExams.forEach(exam => {
        const examStartDate = new Date(exam.start);
        examStartDate.setHours(0, 0, 0, 0);

        const diff = Math.ceil((examStartDate - today) / 86400000);

        const alertDays = [7, 5, 3, 1, 0];
        if (alertDays.includes(diff) && diff >= 0) { // 시험이 지나지 않은 경우만
            const notificationId = getNotificationTag(exam, diff);

            if (!currentSentExams[notificationId]) {
                // 아직 보내지 않은 알림이라면 전송
                sendNotificationSW(exam.title, exam.subject, diff);

                // 알림 보냈다고 기록
                currentSentExams[notificationId] = true;
                caches.open(CACHE_NAME).then(cache => {
                    cache.put('sent-notifications', new Response(JSON.stringify(swSentNotifications)));
                });
            }
        }
    });
}

// Service Worker도 5분마다 깨워서 알림을 체크하게 한다.
// 이건 브라우저가 완전히 닫혀있으면 안 동작할 수 있지만,
// 탭이 닫혀있어도 브라우저 프로세스가 살아있으면 동작할 가능성이 있다.
setInterval(checkAndSendNotificationsSW, 5 * 60 * 1000); // 5분마다 체크!
