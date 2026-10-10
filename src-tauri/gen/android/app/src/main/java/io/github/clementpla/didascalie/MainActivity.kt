package io.github.clementpla.didascalie

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.MotionEvent
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Edge-to-edge is mandatory on recent Android, so the webview would sit
    // under the status bar, the taskbar and the keyboard. Inset it instead:
    // the page then lays out in exactly the area the user can see and touch.
    val content = findViewById<View>(android.R.id.content)
    window.decorView.setBackgroundColor(Color.parseColor("#18181B"))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    receiveProject(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receiveProject(intent)
  }

  // A pen stroke made with the pen's side button held never reaches the page:
  // the webview takes it as a right-click gesture and reports one context menu
  // when the pen lifts. The page binds that button itself (eraser, pan…), and
  // already knows it is held from the hover that precedes the stroke, so the
  // stroke is passed on as an ordinary one, with the button taken out.
  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    val penButton = MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_SECONDARY
    val isPen = event.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS
    if (!isPen || event.buttonState and penButton == 0) {
      return super.dispatchTouchEvent(event)
    }

    val count = event.pointerCount
    val properties = Array(count) { MotionEvent.PointerProperties() }
    val coords = Array(count) { MotionEvent.PointerCoords() }
    for (i in 0 until count) {
      event.getPointerProperties(i, properties[i])
      event.getPointerCoords(i, coords[i])
    }
    val plain = MotionEvent.obtain(
      event.downTime, event.eventTime, event.action, count, properties, coords,
      event.metaState, event.buttonState and penButton.inv(),
      event.xPrecision, event.yPrecision, event.deviceId, event.edgeFlags,
      event.source, event.flags
    )
    try {
      return super.dispatchTouchEvent(plain)
    } finally {
      plain.recycle()
    }
  }

  // "Open with Didascalie" on a .dida file. The file is only reachable through
  // this intent's URI, and only for a while, so it is copied at once into the
  // application's storage; the page picks it up from there when it is shown
  // (`take_incoming_project`).
  private fun receiveProject(intent: Intent?) {
    val uri = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data ?: return
    try {
      val inbox = File(applicationInfo.dataDir, "inbox").apply { mkdirs() }
      val partial = File(inbox, "incoming.part")
      contentResolver.openInputStream(uri)?.use { input ->
        partial.outputStream().use { input.copyTo(it) }
      } ?: return
      partial.renameTo(File(inbox, "incoming.dida"))
    } catch (error: Exception) {
      Log.e("Didascalie", "Could not receive the project", error)
    }
  }
}
