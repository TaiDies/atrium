package io.github.taidies.atrium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateSourceTest {
  private val ok = "https://github.com/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk"

  @Test
  fun acceptsOurReleaseApk() {
    assertTrue(UpdateSource.isReleaseApk(ok))
    assertTrue(UpdateSource.isReleaseApk("https://github.com/TaiDies/atrium/releases/download/v2.0.0-rc.1/Atrium.apk"))
  }

  @Test
  fun refusesOtherReposHostsAndFiles() {
    listOf(
      "https://github.com/other/repo/releases/download/v1.11.10/Atrium.apk",
      "https://github.com/TaiDies/atrium-evil/releases/download/v1.11.10/Atrium.apk",
      "https://github.com.evil.example/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk",
      "https://evil.example/https://github.com/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk",
      "http://github.com/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/download/v1.11.10/Other.apk",
      "https://github.com/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk?x=1",
      "https://github.com/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk#frag",
      "https://user@github.com/TaiDies/atrium/releases/download/v1.11.10/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/latest/download/Atrium.apk",
    ).forEach { assertFalse(it, UpdateSource.isReleaseApk(it)) }
  }

  @Test
  fun refusesPathTraversal() {
    listOf(
      "https://github.com/TaiDies/atrium/releases/download/../../other/repo/releases/download/v1/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/download/v1.11.10/../../../../other/repo/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/download/%2e%2e/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/download/v1.11.10%2F..%2F..%2Fother/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/download/v1.11.10\\..\\x/Atrium.apk",
      "https://github.com/TaiDies/atrium/releases/download//Atrium.apk",
    ).forEach { assertFalse(it, UpdateSource.isReleaseApk(it)) }
  }

  @Test
  fun redirectHops() {
    assertTrue(UpdateSource.isAllowedHop(ok))
    assertTrue(UpdateSource.isAllowedHop("https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=y"))
    assertTrue(UpdateSource.isAllowedHop("https://objects.githubusercontent.com/github-production-release-asset-2e65be/1"))
    listOf(
      "https://evil.githubusercontent.com/x",
      "https://raw.githubusercontent.com/other/repo/main/Atrium.apk",
      "https://github.com.evil.example/x",
      "http://release-assets.githubusercontent.com/x",
      "https://release-assets.githubusercontent.com:8443/x",
      "https://user@release-assets.githubusercontent.com/x",
      "not a url",
    ).forEach { assertFalse(it, UpdateSource.isAllowedHop(it)) }
  }
}
