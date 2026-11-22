class LmspeedAudit < Formula
  desc "Evidence-based LLM API and relay auditing"
  homepage "https://lmspeed.net/audit"
  url "https://github.com/nexmoe/lmspeed-audit/releases/download/v0.3.1/lmspeed-audit-0.3.1.tar.gz"
  sha256 "f43be2e84041c9c4e34b42d57f5e33b33b0c81fd1dfa11fbd038768d63d0d9b2"
  license "Apache-2.0"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"lmspeed-audit").write_env_script libexec/"lmspeed-audit.mjs",
                                         PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/lmspeed-audit --version").strip
    probes = JSON.parse(shell_output("#{bin}/lmspeed-audit list --format json"))
    assert_includes probes, "stream_integrity"
    assert_includes probes, "tool_calling"
  end
end
