package io.github.taidies.atrium

import android.app.PictureInPictureParams
import android.content.res.Configuration
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
