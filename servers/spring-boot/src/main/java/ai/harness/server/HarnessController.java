package ai.harness.server;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HarnessController {
  private final HarnessBridge bridge;

  public HarnessController(HarnessBridge bridge) {
    this.bridge = bridge;
  }

  @GetMapping({ "/", "/health", "/actuator/health" })
  public Map<String, Object> health() {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", bridge.alive());
    out.put("status", bridge.alive() ? "UP" : "DOWN");
    out.put("name", "harness");
    out.put("rpc", "/rpc");
    out.put("root", bridge.root().toString());
    return out;
  }

  @PostMapping("/rpc")
  public ResponseEntity<Map<String, Object>> rpc(@RequestBody Map<String, Object> body) throws Exception {
    return ResponseEntity.ok(bridge.request(body));
  }
}
