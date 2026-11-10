package io.github.taidies.atrium

/**
 * Where app updates may come from. Only our own GitHub releases: the exact address of the APK in a
 * release, and the hosts GitHub sends those downloads on to. A fork changes [REPO] (and nothing else).
 * Plain Kotlin with no Android parts, so it can be unit-tested (UpdateSourceTest).
 */
object UpdateSource {
  /** The GitHub repository whose releases the app updates from ("owner/name"). */
  const val REPO = "TaiDies/atrium"

  /** The file name of the Android app in a release. */
  const val APK = "Atrium.apk"

  /** Where GitHub redirects release downloads to (checked November 2026: release-assets; objects is the older one). */
  val REDIRECT_HOSTS = setOf("release-assets.githubusercontent.com", "objects.githubusercontent.com")

  private val PREFIX = "https://github.com/$REPO/releases/download/"

  /** A release tag like v1.11.10 (optionally with a suffix such as -rc.1): no slashes, dots-only segments or escapes. */
  private val TAG = Regex("^v\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(-[0-9A-Za-z]+(\\.[0-9A-Za-z]+)*)?$")

  /** Whether [url] is exactly https://github.com/<REPO>/releases/download/<tag>/Atrium.apk. */
  fun isReleaseApk(url: String): Boolean {
    if (!url.startsWith(PREFIX)) return false
    val rest = url.substring(PREFIX.length)
    val slash = rest.indexOf('/')
    if (slash <= 0) return false
    val tag = rest.substring(0, slash)
    val file = rest.substring(slash + 1)
    return TAG.matches(tag) && file == APK
  }

  /** Whether a download may be fetched from (or redirected to) this address: https on GitHub's release hosts. */
  fun isAllowedHop(url: String): Boolean {
    val uri = try {
      java.net.URI(url)
    } catch (_: Exception) {
      return false
    }
    if (uri.scheme != "https" || uri.userInfo != null || (uri.port != -1 && uri.port != 443)) return false
    val host = uri.host?.lowercase() ?: return false
    return host == "github.com" || host in REDIRECT_HOSTS
  }
}
