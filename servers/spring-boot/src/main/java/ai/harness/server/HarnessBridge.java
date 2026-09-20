package ai.harness.server;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;

/**
 * Extracts the bundled Harness runtime and talks JSON-RPC over stdio.
 * Spring Boot is a Maven dependency here — Spring Framework source is not vendored.
 */
@Component
public class HarnessBridge implements DisposableBean {
  private static final ObjectMapper JSON = new ObjectMapper();
  private final Process process;
  private final BufferedWriter stdin;
  private final Path root;
  private final AtomicInteger nextId = new AtomicInteger(1);
  private final Map<String, Waiter> pending = new ConcurrentHashMap<>();

  public HarnessBridge() throws IOException {
    this.root = extractRuntime();
    Path bin = nativeBinary(root);
    ProcessBuilder pb;
    if (bin != null) {
      pb = new ProcessBuilder(bin.toString(), "serve");
    } else {
      Path cjs = root.resolve("dist").resolve("harness.cjs");
      pb = new ProcessBuilder("node", cjs.toString(), "serve");
    }
    pb.directory(root.toFile());
    pb.environment().put("HARNESS_ROOT", root.toString());
    this.process = pb.start();
    this.stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
    Thread reader = new Thread(this::readLoop, "harness-rpc");
    Thread err = new Thread(() -> drain(process.getErrorStream()), "harness-err");
    reader.setDaemon(true);
    err.setDaemon(true);
    reader.start();
    err.start();
  }

  public Path root() {
    return root;
  }

  public boolean alive() {
    return process.isAlive();
  }

  public synchronized Map<String, Object> request(Map<String, Object> body) throws Exception {
    Object id = body.get("id");
    if (id == null) {
      id = nextId.getAndIncrement();
      body.put("id", id);
    }
    body.putIfAbsent("jsonrpc", "2.0");
    String key = String.valueOf(id);
    Waiter waiter = new Waiter();
    pending.put(key, waiter);
    stdin.write(JSON.writeValueAsString(body));
    stdin.write("\n");
    stdin.flush();
    Map<String, Object> result = waiter.await(120, TimeUnit.SECONDS);
    if (result == null) throw new IllegalStateException("rpc timeout");
    return result;
  }

  private void readLoop() {
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.isBlank()) continue;
        Map<String, Object> msg = JSON.readValue(line, new TypeReference<Map<String, Object>>() {});
        Object id = msg.get("id");
        if (id == null) continue;
        Waiter waiter = pending.remove(String.valueOf(id));
        if (waiter != null) waiter.complete(msg);
      }
    } catch (IOException ignored) {
      /* process exited */
    }
  }

  private static void drain(InputStream in) {
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
      while (reader.readLine() != null) {
        /* keep stderr from filling the pipe */
      }
    } catch (IOException ignored) {
      /* closed */
    }
  }

  static Path extractRuntime() throws IOException {
    Path dest = Path.of(System.getProperty("user.home", "."), ".harness", "runtime");
    Files.createDirectories(dest);
    try (InputStream in = resource("harness/files.txt")) {
      if (in == null) throw new IOException("missing harness/files.txt");
      List<String> files = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)).lines().toList();
      for (String rel : files) {
        if (rel.isBlank() || rel.startsWith("#")) continue;
        Path out = dest.resolve(rel);
        Files.createDirectories(out.getParent());
        try (InputStream file = resource("harness/" + rel)) {
          if (file == null) continue;
          Files.copy(file, out, StandardCopyOption.REPLACE_EXISTING);
        }
        if (rel.contains("natives/") && !rel.endsWith(".exe")) {
          out.toFile().setExecutable(true, false);
        }
      }
    }
    return dest;
  }

  private static InputStream resource(String name) {
    return HarnessBridge.class.getClassLoader().getResourceAsStream(name);
  }

  private static Path nativeBinary(Path root) {
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    String arch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
    String id;
    String bin = "harness";
    if (os.contains("win")) {
      id = "win-x64";
      bin = "harness.exe";
    } else if (os.contains("mac") || os.contains("darwin")) {
      id = arch.contains("aarch") || arch.contains("arm") ? "darwin-arm64" : "darwin-x64";
    } else {
      id = arch.contains("aarch") || arch.contains("arm") ? "linux-arm64" : "linux-x64";
    }
    Path nativePath = root.resolve("natives").resolve(id).resolve(bin);
    if (Files.isRegularFile(nativePath) && nativePath.toFile().canExecute()) return nativePath;
    return null;
  }

  @Override
  public void destroy() {
    process.destroy();
    try {
      if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      process.destroyForcibly();
    }
  }

  static final class Waiter {
    private Map<String, Object> value;

    synchronized void complete(Map<String, Object> msg) {
      value = msg;
      notifyAll();
    }

    synchronized Map<String, Object> await(long time, TimeUnit unit) throws InterruptedException {
      long deadline = System.nanoTime() + unit.toNanos(time);
      while (value == null) {
        long left = deadline - System.nanoTime();
        if (left <= 0) return null;
        wait(Math.max(1, TimeUnit.NANOSECONDS.toMillis(left)));
      }
      return value;
    }
  }
}
