package io.github.taidies.atrium

import android.app.PictureInPictureParams
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.content.res.Configuration
import android.net.Uri
import android.os.Environment
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.webkit.WebViewClient
import android.graphics.Color
import android.os.Build
import android.util.Rational
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keep the app clear of the status bar, navigation bar, camera cutout and keyboard, so the page
    // shrinks when the keyboard opens instead of the keyboard covering what's being typed into.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val edges = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(edges.left, edges.top, edges.right, edges.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // The back button: an open sheet, menu or sidebar closes first (the page answers "handled"); otherwise
  // go back a page, and leave from the first one. Tauri's own back handler (which only goes back a page)
  // is added when the page loads, so ours is added again afterwards to stay on top - the newest runs
  // first. (The page also listens for Tauri's "back-button" event, in case Tauri's runs anyway.)
  private var web: WebView? = null
  private var back: OnBackPressedCallback? = null
  /** In a meeting call (the page says so): leaving the app shrinks it into a picture-in-picture pop-up. */
  private var inCall = false

  /** Files being saved from the page (see Bars.saveBegin). */
  private class Save(val out: java.io.OutputStream, val uri: Uri?, val file: java.io.File?)
  private val saves = java.util.concurrent.ConcurrentHashMap<String, Save>()
  private var printing: WebView? = null

  private fun pipParams(): PictureInPictureParams? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
    val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(inCall)
    return b.build()
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    // (On Android 12 and later it happens by itself, from setAutoEnterEnabled.)
    if (inCall && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      try {
        enterPictureInPictureMode(pipParams()!!)
      } catch (_: IllegalStateException) {
        // picture-in-picture not available on this device
      }
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    // The page shows just the call while it's a pop-up.
    web?.evaluateJavascript("window.__afPip && window.__afPip($isInPictureInPictureMode)", null)
  }

  private fun claimBack() {
    back?.remove()
    back = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = web ?: return leave()
        view.evaluateJavascript("(window.__afBack && window.__afBack()) ? 'handled' : ''") { result ->
          if (result != null && result.contains("handled")) return@evaluateJavascript
          if (view.canGoBack()) view.goBack() else leave()
        }
      }
    }.also { onBackPressedDispatcher.addCallback(this, it) }
  }

  private fun leave() {
    moveTaskToBack(true)
  }

  override fun onResume() {
    super.onResume()
    claimBack()
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.post { claimBack() }
    // The app tells Android its colours, so the status and navigation bars match its theme.
    webView.addJavascriptInterface(Bars(), "AfAndroid")
  }

  inner class Bars {
    /** The page joined or left a call. */
    @JavascriptInterface
    fun setInCall(on: Boolean) {
      runOnUiThread {
        inCall = on
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          try {
            setPictureInPictureParams(pipParams()!!)
          } catch (_: IllegalStateException) {
            // picture-in-picture not available on this device
          }
        }
      }
    }

    /** Back with nothing open and no page to go back to: leave, like other apps (the app keeps running). */
    @JavascriptInterface
    fun leave() {
      runOnUiThread { leave() }
    }

    // ----- saving files (exports, attachments) to Downloads, handed over by the page in pieces -----

    /** Starts a file; returns its id, or "" if it can't be made. */
    @JavascriptInterface
    fun saveBegin(name: String, mime: String): String {
      return try {
        val id = java.util.UUID.randomUUID().toString()
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]+"), "-").take(150).ifBlank { "download" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safe)
            put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
          }
          val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return ""
          val out = contentResolver.openOutputStream(uri) ?: return ""
          saves[id] = Save(out, uri, null)
        } else {
          // Android 9 and older: the app's own Downloads folder, which needs no storage permission.
          val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return ""
          dir.mkdirs()
          val file = java.io.File(dir, safe)
          saves[id] = Save(java.io.FileOutputStream(file), null, file)
        }
        id
      } catch (_: Exception) {
        ""
      }
    }

    @JavascriptInterface
    fun saveChunk(id: String, base64: String): Boolean {
      val s = saves[id] ?: return false
      return try {
        s.out.write(Base64.decode(base64, Base64.DEFAULT))
        true
      } catch (_: Exception) {
        false
      }
    }

    /** Finishes a file; returns "" when it's saved, or what went wrong. */
    @JavascriptInterface
    fun saveEnd(id: String): String {
      val s = saves.remove(id) ?: return "The download was interrupted"
      return try {
        s.out.close()
        if (s.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          contentResolver.update(s.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        }
        ""
      } catch (e: Exception) {
        e.message ?: "Could not save the file"
      }
    }

    @JavascriptInterface
    fun saveAbort(id: String) {
      val s = saves.remove(id) ?: return
      try {
        s.out.close()
      } catch (_: Exception) {
      }
      if (s.uri != null) contentResolver.delete(s.uri, null, null)
      s.file?.delete()
    }

    /** Prints a complete HTML page with Android's print service (where "Save as PDF" is one of the printers). */
    @JavascriptInterface
    fun printHtml(html: String, title: String) {
      runOnUiThread {
        val view = WebView(this@MainActivity)
        var started = false
        view.webViewClient = object : WebViewClient() {
          override fun onPageFinished(v: WebView, url: String?) {
            if (started) return
            started = true
            val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
            val name = title.ifBlank { "Document" }
            manager.print(name, v.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
          }
        }
        printing = view // kept until the next print, so it isn't collected while printing
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
      }
    }

    // ----- updating the app: the page finds a newer release on GitHub, the app downloads the APK,
    // checks its SHA-256 against the release's, and hands it to Android's installer (the person taps
    // Install; Android only accepts it if it's signed with the same key as the installed app) -----

    /** Whether Android lets this app open the installer (Settings → Install unknown apps). */
    @JavascriptInterface
    fun canInstallUpdates(): Boolean =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

    /** Opens the switch that lets this app install updates. */
    @JavascriptInterface
    fun openInstallSettings() {
      runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
        }
      }
    }

    /**
     * Downloads the APK at `url` (GitHub only), checks it against `sha256` (hex) and opens the installer.
     * Progress and the outcome are reported to window.__afUpdate({ progress }) / ({ error }) / ({ done }).
     */
    @JavascriptInterface
    fun installUpdate(url: String, sha256: String) {
      val report = { json: String -> runOnUiThread { web?.evaluateJavascript("window.__afUpdate && window.__afUpdate($json)", null) } }
      Thread {
        try {
          val host = Uri.parse(url).host ?: ""
          if (!url.startsWith("https://") || !(host == "github.com" || host.endsWith(".githubusercontent.com"))) throw Exception("Updates only come from GitHub")
          if (!Regex("^[0-9a-f]{64}$").matches(sha256)) throw Exception("The release has no checksum to verify the download")
          val dir = java.io.File(cacheDir, "updates").apply { mkdirs() }
          dir.listFiles()?.forEach { it.delete() }
          val file = java.io.File(dir, "Atrium.apk")
          val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
          conn.instanceFollowRedirects = true
          conn.connectTimeout = 15000
          conn.readTimeout = 30000
          conn.connect()
          if (conn.responseCode != 200) throw Exception("Download failed (${conn.responseCode})")
          val finalHost = conn.url.host ?: ""
          if (!(finalHost == "github.com" || finalHost.endsWith(".githubusercontent.com"))) throw Exception("Updates only come from GitHub")
          val total = conn.contentLengthLong
          val digest = java.security.MessageDigest.getInstance("SHA-256")
          var done = 0L
          var last = -1
          conn.inputStream.use { input ->
            java.io.FileOutputStream(file).use { out ->
              val buf = ByteArray(64 * 1024)
              while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                digest.update(buf, 0, n)
                done += n
                val pct = if (total > 0) (done * 100 / total).toInt() else -1
                if (pct != last) { last = pct; report("{\"progress\":$pct}") }
              }
            }
          }
          val hex = digest.digest().joinToString("") { "%02x".format(it) }
          if (hex != sha256) {
            file.delete()
            throw Exception("The download didn't match the release's checksum")
          }
          val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
          runOnUiThread {
            startActivity(Intent(Intent.ACTION_VIEW).apply {
              setDataAndType(uri, "application/vnd.android.package-archive")
              addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            })
          }
          report("{\"done\":true}")
        } catch (e: Exception) {
          report("{\"error\":${org.json.JSONObject.quote(e.message ?: "The update couldn't be downloaded")}}")
        }
      }.start()
    }

    @JavascriptInterface
    fun setBars(color: String, lightBackground: Boolean) {
      runOnUiThread {
        try {
          window.decorView.setBackgroundColor(Color.parseColor(color))
          val controller = WindowInsetsControllerCompat(window, window.decorView)
          controller.isAppearanceLightStatusBars = lightBackground
          controller.isAppearanceLightNavigationBars = lightBackground
        } catch (_: IllegalArgumentException) {
          // Not a colour Android understands: leave the bars as they are.
        }
      }
    }
  }
}
