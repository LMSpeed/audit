class LmspeedAudit < Formula
  desc "Evidence-based LLM API and relay auditing"
  homepage "https://lmspeed.net/audit"
  url "https://github.com/lmspeed/audit/releases/download/v0.3.3/lmspeed-audit-0.3.3.tar.gz"
  sha256 "3d3e9d8955807a30464deebbb09d0f5c13703d5a4f08b25adf86950c36ede5af"
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
