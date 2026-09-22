/** 배치를 워커에서 돌린다 — 얇은 껍데기다.
 *
 *  예제 하나가 8~107 초라 메인 스레드에서 돌리면 페이지가 통째로 언다.
 *  실제 일은 src/job.mjs 가 한다. 그 파일을 워커 밖에서도 부를 수 있게 갈라
 *  두었다 — 모듈 워커가 서지 않는 브라우저에서는 index.html 이 같은 함수를
 *  직접 부른다.
 */
import { runJob } from "./src/job.mjs";

self.onmessage = (e) => runJob(e.data, (m) => postMessage(m));
