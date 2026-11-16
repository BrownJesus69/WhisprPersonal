package com.aditya.whisprkeyboard

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.inputmethodservice.InputMethodService
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.google.firebase.auth.FirebaseAuth
import com.google.android.gms.tasks.Tasks
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

class WhisprKeyboardService : InputMethodService() {
    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "Keyboard audio and upload (~120 s)") }
    private val guard = InsertionGuard()
    private lateinit var config: KeyboardConfig
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private lateinit var languageButton: Button
    private lateinit var mic: Button
    private lateinit var preview: TextView
    private lateinit var actions: LinearLayout
    private lateinit var level: ProgressBar
    private lateinit var enter: Button
    private var sessionId = 0L
    private var editor: EditorIdentity? = null
    private var target: EditorIdentity? = null
    private var visible = false
    @Volatile private var destroyed = false
    @Volatile private var listening = false
    @Volatile private var recorder: AudioRecord? = null
    private var busy = false
    @Volatile private var requestId = 0L
    @Volatile private var activeConnection: HttpURLConnection? = null
    private var audio: ByteArray? = null
    private var result: String? = null
    private var resultUid: String? = null
    private var uploadUid: String? = null
    private var recordedLanguage = "auto"
    private var recordedEvent = ""
    private var language = "auto"
    private val languages = listOf("auto", "kn", "ta", "hi", "en")
    private val labels = listOf("Auto-detect", "Kannada", "Tamil", "Hindi", "English")
    private var message = "Ready"
    private var undoText: String? = null
    private var undoEditor: EditorIdentity? = null
    private var focus: AudioFocusRequest? = null
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change < 0) main.post { if (listening) stopRecording() }
    }
    private var repeating = false
    private val repeatDelete = object : Runnable {
        override fun run() {
            if (repeating) { currentInputConnection?.deleteSurroundingText(1, 0); clearUndo(); main.postDelayed(this, 70) }
        }
    }
    override fun onCreate() { super.onCreate(); config = KeyboardConfig(this) }
    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label; contentDescription = label; minWidth = dp(48); minHeight = dp(48)
        setOnClickListener { action() }
    }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    override fun onCreateInputView(): View {
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val textColor = Color.parseColor(if (dark) "#F1F3EE" else "#222521")
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; minimumHeight = dp(220); setPadding(dp(8), 0, dp(8), 0)
            setBackgroundColor(Color.parseColor(if (dark) "#141816" else "#F7F6F2"))
        }
        val top = row()
        languageButton = button("Auto-detect") {
            language = languages[(languages.indexOf(language) + 1).mod(languages.size)]; render()
        }
        top.addView(languageButton)
        status = TextView(this).apply { setTextColor(textColor); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        top.addView(status, LinearLayout.LayoutParams(0, dp(48), 1f)); root.addView(top)
        val center = row().apply { gravity = Gravity.CENTER }
        mic = button("Start") {
            if (config.bool("haptics", true)) mic.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            if (listening) stopRecording() else startRecording()
        }
        center.addView(mic, LinearLayout.LayoutParams(dp(64), dp(64)))
        root.addView(center, LinearLayout.LayoutParams(-1, dp(72)))
        level = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; contentDescription = "Microphone level" }
        root.addView(level, LinearLayout.LayoutParams(-1, dp(4)))
        preview = TextView(this).apply { setTextColor(textColor); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        root.addView(preview)
        actions = row(); root.addView(actions)
        val bottom = row()
        bottom.addView(button("Switch keyboard") {
            if (Build.VERSION.SDK_INT < 28 || !switchToNextInputMethod(false)) {
                (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
            }
        }, LinearLayout.LayoutParams(0, dp(48), 1f))
        val backspace = button("Backspace") { currentInputConnection?.deleteSurroundingText(1, 0); clearUndo() }
        backspace.setOnLongClickListener { repeating = true; main.post(repeatDelete); true }
        backspace.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                repeating = false; main.removeCallbacks(repeatDelete)
            }; false
        }
        bottom.addView(backspace, LinearLayout.LayoutParams(0, dp(48), 1f))
        enter = button("Enter") {
            val info = currentInputEditorInfo
            if (info != null && info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION == 0 &&
                info.imeOptions and EditorInfo.IME_MASK_ACTION in 2..7) {
                currentInputConnection?.performEditorAction(info.imeOptions and EditorInfo.IME_MASK_ACTION)
            } else currentInputConnection?.commitText("\n", 1)
            clearUndo()
        }
        bottom.addView(enter, LinearLayout.LayoutParams(0, dp(48), 1f)); root.addView(bottom)
        render(); return root
    }
    override fun onStartInput(info: EditorInfo?, restarting: Boolean) {
        super.onStartInput(info, restarting); sessionId++
        editor = info?.let { EditorIdentity(it.packageName ?: "", it.fieldId, it.inputType, sessionId) }
        clearUndo(); render()
    }
    override fun onFinishInput() {
        sessionId++; editor = null; visible = false; repeating = false; main.removeCallbacks(repeatDelete)
        clearUndo(); super.onFinishInput(); render()
    }
    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting); visible = true
        language = config.string("languageMode", "auto").takeIf { it in languages } ?: "auto"
        render()
    }
    override fun onFinishInputView(finishingInput: Boolean) {
        visible = false; repeating = false; main.removeCallbacks(repeatDelete); clearUndo()
        super.onFinishInputView(finishingInput)
    }
    private fun sensitive() = editor?.let { InsertionGuard.isSensitive(it.inputType) } ?: true
    private fun signedIn() = try { FirebaseAuth.getInstance().currentUser } catch (_: Exception) { null }
    private fun launchApp() {
        packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    private fun render() {
        if (!::root.isInitialized || destroyed) return
        val user = signedIn()
        // Never expose a previous account's words after account switching/sign-out.
        if ((result != null || audio != null) && uploadUid != user?.uid) discard()
        val permission = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val configured = config.string("serverUrl").isNotBlank() && config.secret().isNotBlank()
        val problem = when {
            sensitive() -> "Voice input is off for password fields"
            !permission -> "Allow microphone in WhisprPersonal"
            user == null -> "Open WhisprPersonal and sign in"
            !configured -> "Open WhisprPersonal and connect your computer"
            else -> null
        }
        status.text = problem ?: message
        mic.isEnabled = listening || (!busy && problem == null && audio == null && result == null)
        mic.text = if (listening) "Stop" else "Start"
        mic.contentDescription = if (listening) "Stop recording" else "Start speaking"
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        mic.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor(if (listening) { if (dark) "#FFB4AB" else "#B3261E" } else { if (dark) "#9DD8BE" else "#17675A" }))
        }
        mic.setTextColor(Color.parseColor(if (dark) { if (listening) "#690005" else "#102B20" } else "#FFFFFF"))
        languageButton.text = labels[languages.indexOf(language).coerceAtLeast(0)]
        languageButton.contentDescription = "Language: ${languageButton.text}"
        languageButton.isEnabled = !listening && !busy && audio == null && result == null
        val action = if ((currentInputEditorInfo?.imeOptions ?: 0) and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0) 0
                     else (currentInputEditorInfo?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        enter.text = mapOf(2 to "Go", 3 to "Search", 4 to "Send", 5 to "Next", 6 to "Done", 7 to "Previous")[action] ?: "Enter"
        enter.contentDescription = enter.text
        preview.text = result ?: ""; preview.contentDescription = result ?: "Result preview"
        preview.visibility = if (result == null || sensitive()) View.GONE else View.VISIBLE
        actions.removeAllViews()
        if (problem != null && !sensitive()) actions.addView(button("Open WhisprPersonal", ::launchApp))
        if (result != null && !sensitive()) {
            actions.addView(button(if (target == editor) "Insert" else "Insert here") { insert(true) })
            actions.addView(button("Copy") {
                if (resultUid == signedIn()?.uid) (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("Dictation", result))
            })
        } else if (audio != null && !busy && !listening && problem == null) actions.addView(button("Try again", ::upload))
        if (result != null || audio != null) actions.addView(button("Discard", ::discard))
        if (undoText != null) actions.addView(button("Undo", ::undo))
    }
    private fun startRecording() {
        if (listening || busy || sensitive() || editor == null || signedIn() == null ||
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        target = editor; requestId++; uploadUid = signedIn()?.uid; recordedLanguage = language
        recordedEvent = config.string("speakEventId"); clearUndo()
        val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val focusResult = if (Build.VERSION.SDK_INT >= 26) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(focusListener).build()
            focus = req
            manager.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        }
        if (focusResult != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            releaseFocus()
            message = "Microphone is busy"; render(); return
        }
        try {
            val size = AudioRecord.getMinBufferSize(16000, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT)
            check(size > 0)
            val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT, maxOf(size, 6400))
            recorder = record; check(record.state == AudioRecord.STATE_INITIALIZED)
            record.startRecording(); check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING)
            listening = true; message = "Listening… 0:00"; render()
            executor.execute {
                val output = ByteArrayOutputStream()
                val samples = ShortArray(1600)
                var failed = false
                try {
                    while (listening && !destroyed && output.size() < 120 * 32000) {
                        if (Build.VERSION.SDK_INT >= 29 && record.activeRecordingConfiguration?.isClientSilenced == true) { failed = true; break }
                        val count = record.read(samples, 0, minOf(samples.size, (120 * 32000 - output.size()) / 2))
                        if (count <= 0) { failed = listening; break }
                        var squares = 0.0
                        for (i in 0 until count) {
                            val value = samples[i].toInt(); squares += value.toDouble() * value
                            output.write(value and 255); output.write((value shr 8) and 255)
                        }
                        val rms = (sqrt(squares / count) / 32768 * 500).toInt().coerceIn(0, 100)
                        val seconds = output.size() / 32000
                        main.post {
                            if (listening && !destroyed) { level.progress = rms; message = "Listening… ${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"; status.text = message }
                        }
                    }
                } catch (_: Exception) { failed = listening }
                finally {
                    listening = false
                    try { record.stop() } catch (_: Exception) { }
                    record.release(); recorder = null
                }
                val bytes = output.toByteArray()
                main.post {
                    releaseFocus()
                    if (!destroyed) {
                        level.progress = 0
                        if (failed || bytes.isEmpty()) { busy = false; message = "Microphone is busy"; render() }
                        else {
                            audio = bytes
                            message = if (bytes.size >= 120 * 32000) "Maximum length reached" else "Turning speech into text…"
                            render(); upload()
                        }
                    }
                }
            }
        } catch (_: Exception) {
            recorder?.release(); recorder = null; listening = false; releaseFocus(); message = "Microphone is busy"; render()
        }
    }
    private fun stopRecording() {
        listening = false; busy = true; message = "Turning speech into text…"
        try { recorder?.stop() } catch (_: Exception) { }
        render()
    }
    private fun releaseFocus() {
        val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 26) focus?.let { manager.abandonAudioFocusRequest(it) }
        else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(focusListener)
        }
        focus = null
    }
    private fun wav(pcm: ByteArray): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVEfmt ".toByteArray()).putInt(16)
            .putShort(1.toShort()).putShort(1.toShort()).putInt(16000).putInt(32000).putShort(2.toShort()).putShort(16.toShort())
            .put("data".toByteArray()).putInt(pcm.size)
        return header.array() + pcm
    }
    private fun upload() {
        val bytes = audio ?: return
        if (destroyed) return
        val user = signedIn()
        if (user == null || user.uid != uploadUid) { busy = false; discard(); render(); return }
        busy = true
        val id = requestId
        val server = config.string("serverUrl")
        val key = config.secret()
        val mode = recordedLanguage; val event = recordedEvent
        if (!message.startsWith("Maximum")) message = "Turning speech into text…"
        render()
        executor.execute {
            var temp: File? = null
            var connection: HttpURLConnection? = null
            try {
                val token = Tasks.await(user.getIdToken(false), 20, TimeUnit.SECONDS).token ?: throw IllegalStateException("sign_in")
                if (destroyed || id != requestId) return@execute
                temp = File.createTempFile("whispr-dictation-", ".wav", cacheDir)
                temp.writeBytes(wav(bytes))
                val url = URL(server.trimEnd('/') + "/api/v1/dictation")
                check(url.protocol == "http" || url.protocol == "https")
                connection = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 60000; readTimeout = 60000; instanceFollowRedirects = false
                    doOutput = true; setRequestProperty("Authorization", "Bearer $token")
                    setRequestProperty("X-WhisprPersonal-Server-Key", key)
                    setRequestProperty("Content-Type", "multipart/form-data; boundary=WhisprDictation")
                }
                activeConnection = connection
                if (destroyed || id != requestId) return@execute
                val boundary = "WhisprDictation"
                connection.outputStream.use { out ->
                    fun field(name: String, value: String) { out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray(Charsets.UTF_8)) }
                    field("language", mode)
                    if (event.isNotBlank()) field("event_id", event)
                    out.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n".toByteArray())
                    requireNotNull(temp).inputStream().use { it.copyTo(out) }; out.write("\r\n--$boundary--\r\n".toByteArray())
                }
                val code = connection.responseCode
                if (code !in 200..299) {
                    val body = connection.errorStream?.bufferedReader()?.use { it.readText().take(8192) } ?: ""
                    val error = try { JSONObject(body).optJSONObject("error")?.optString("code") } catch (_: Exception) { null }
                    val words = when {
                        error in listOf("invalid_server_key", "missing_server_key") -> "Server key wrong"
                        code == 401 || code == 403 -> "Sign-in expired. Open WhisprPersonal and sign in"
                        error == "model_not_ready" -> "Speech recognition still loading"
                        code == 422 || code == 413 -> "Recording too long or unsupported"
                        else -> "Computer not reachable"
                    }
                    main.post { if (!destroyed && id == requestId) { busy = false; message = words; render() } }
                } else {
                    val text = JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getString("text")
                    main.post {
                        if (!destroyed && id == requestId && signedIn()?.uid == user.uid) {
                            busy = false; audio = null; result = text; resultUid = user.uid
                            message = if (text.isBlank()) "No speech heard" else "Ready"
                            if (text.isBlank()) result = null
                            else if (!guard.canInsert(id, target, editor, visible)) {
                                message = "The text box changed while your words were processed."
                            } else if (!config.bool("reviewBeforeInsert")) insert(false)
                            render()
                        }
                    }
                }
            } catch (_: Exception) {
                main.post { if (!destroyed && id == requestId) { busy = false; message = "Computer not reachable or sign-in expired"; render() } }
            } finally {
                connection?.disconnect()
                if (activeConnection === connection) activeConnection = null
                temp?.delete()
            }
        }
    }
    private fun insert(explicit: Boolean) {
        val text = result ?: return
        if (guard.alreadyInserted(requestId)) return
        if (resultUid != signedIn()?.uid) { discard(); return }
        if (!explicit && !guard.canInsert(requestId, target, editor, visible)) {
            message = "The text box changed while your words were processed."; render(); return
        }
        if (sensitive() || !visible || editor == null) { message = "Voice input is off for this field"; render(); return }
        val connection = currentInputConnection
        if (connection == null) { message = "The text box changed while your words were processed."; render(); return }
        val previous = connection.getTextBeforeCursor(1, 0)?.lastOrNull()
        val inserted = (if (previous?.isLetterOrDigit() == true) " " else "") + text
        if (connection.commitText(inserted, 1)) {
            guard.markInserted(requestId); result = null; audio = null; undoText = inserted; undoEditor = editor
            message = "Inserted"; val id = requestId
            main.postDelayed({ if (requestId == id) { clearUndo(); render() } }, 5000)
        } else message = "The text box changed while your words were processed."
        render()
    }
    private fun undo() {
        val text = undoText ?: return
        val connection = currentInputConnection
        if (visible && editor == undoEditor && connection != null && guard.canUndo(text, connection.getTextBeforeCursor(text.length, 0))) {
            connection.deleteSurroundingText(text.length, 0)
        }
        clearUndo(); render()
    }
    private fun clearUndo() { undoText = null; undoEditor = null }
    override fun onUpdateSelection(oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int, candidatesStart: Int, candidatesEnd: Int) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        val text = undoText ?: return
        if (newSelStart != newSelEnd || editor != undoEditor || !guard.canUndo(text, currentInputConnection?.getTextBeforeCursor(text.length, 0))) {
            clearUndo(); render()
        }
    }
    private fun discard() {
        requestId++; activeConnection?.disconnect(); audio = null; result = null
        resultUid = null; busy = false; message = "Ready"; render()
    }
    override fun onDestroy() {
        destroyed = true; listening = false
        activeConnection?.disconnect()
        try { recorder?.stop() } catch (_: Exception) { }
        // The recording task owns release(), avoiding a concurrent read/release race.
        releaseFocus(); audio = null; result = null; main.removeCallbacksAndMessages(null)
        executor.shutdownNow(); super.onDestroy()
    }
}
