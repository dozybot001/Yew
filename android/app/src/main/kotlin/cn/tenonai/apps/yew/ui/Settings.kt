package cn.tenonai.apps.yew.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringArrayResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import cn.tenonai.apps.yew.AppModel
import cn.tenonai.apps.yew.BuildConfig
import cn.tenonai.apps.yew.Link
import cn.tenonai.apps.yew.Page
import cn.tenonai.apps.yew.R
import cn.tenonai.apps.yew.update.ReleaseCheck

private fun Context.open(intent: Intent) {
    try {
        startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // No app on this phone takes it (no browser, no mail app); the address stays readable on the page.
    }
}

/** Counts up each time the app comes back to the front, so what system settings changed is read again. */
@Composable
private fun resumes(): Int {
    val owner = LocalActivity.current as ComponentActivity
    var count by remember { mutableIntStateOf(0) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) count += 1 }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    return count
}

/**
 * Settings, from the button at the top right of each tab: the computer this phone is paired with,
 * notifications, unpairing, and About. Everything else is set on the computer.
 */
@SuppressLint("BatteryLife")
@Composable
fun SettingsScreen(model: AppModel, close: () -> Unit) {
    val context = LocalContext.current
    var confirming by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    // Read again after each change here and each return from system settings.
    var changes by remember { mutableIntStateOf(0) }
    val version = resumes() + changes
    val allowed = remember(version) { model.notifier.allowed }
    val wanted = remember(version) { model.notifier.wanted }
    val asked = remember(version) { model.notifier.asked }
    val keep = remember(version) { model.notifier.keepAfterClose }
    val unrestricted = remember(version) {
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        model.notifier.asked = true
        model.notifier.wanted = true
        model.syncService()
        changes += 1
    }

    Screen(stringResource(R.string.settings), onBack = close) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            Group {
                GroupRow(stringResource(R.string.computer), model.desktopName.orEmpty())
                GroupDivider()
                GroupRow(
                    stringResource(R.string.connection),
                    stringResource(
                        when {
                            model.isDemo -> R.string.link_demo
                            model.link == Link.Connecting -> R.string.link_connecting
                            model.link == Link.Online -> R.string.link_online
                            model.link == Link.ComputerOffline -> R.string.link_offline
                            model.link == Link.Refused -> R.string.link_refused
                            else -> R.string.link_unreachable
                        },
                    ),
                )
            }
            Footnote(stringResource(if (model.isDemo) R.string.settings_demo_note else R.string.settings_paired_note))

            if (!model.isDemo) {
                SectionTitle(stringResource(R.string.notifications))
                Group {
                    GroupRow(
                        stringResource(R.string.notifications),
                        stringResource(
                            when {
                                allowed && wanted -> R.string.notifications_on
                                !allowed && asked -> R.string.notifications_blocked
                                else -> R.string.notifications_off
                            },
                        ),
                    )
                    GroupDivider()
                    when {
                        allowed && wanted -> GroupRow(stringResource(R.string.notifications_turn_off), onClick = {
                            model.notifier.wanted = false
                            model.syncService()
                            changes += 1
                        })
                        allowed -> GroupRow(stringResource(R.string.notifications_turn_on), onClick = {
                            model.notifier.wanted = true
                            model.syncService()
                            changes += 1
                        })
                        // Android asks once; after a refusal (and before Android 13) only system settings turn it on.
                        Build.VERSION.SDK_INT >= 33 && !asked -> GroupRow(stringResource(R.string.notifications_turn_on), onClick = {
                            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        })
                        else -> GroupRow(stringResource(R.string.open_system_settings), onClick = {
                            model.notifier.wanted = true
                            context.open(
                                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                            )
                        })
                    }
                    if (allowed && wanted) {
                        GroupDivider()
                        GroupRow(
                            stringResource(R.string.after_close),
                            stringResource(if (keep) R.string.after_close_keep else R.string.after_close_stop),
                        )
                        GroupDivider()
                        GroupRow(
                            stringResource(if (keep) R.string.after_close_turn_off else R.string.after_close_turn_on),
                            onClick = {
                                model.notifier.keepAfterClose = !keep
                                // Started again so the service picks up whether the system may restart it.
                                model.syncService()
                                changes += 1
                            },
                        )
                    }
                    GroupDivider()
                    GroupRow(
                        stringResource(R.string.background),
                        stringResource(if (unrestricted) R.string.background_allowed else R.string.background_limited),
                    )
                    if (!unrestricted) {
                        GroupDivider()
                        GroupRow(stringResource(R.string.background_allow), onClick = {
                            context.open(
                                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.fromParts("package", context.packageName, null)),
                            )
                        })
                    }
                }
                Footnote(stringResource(R.string.notifications_note))
                Footnote(stringResource(R.string.background_note))
            }

            Spacer(Modifier.height(16.dp))
            Group {
                if (model.isDemo) {
                    GroupRow(stringResource(R.string.leave_demo), onClick = { model.leaveDemo() })
                } else {
                    GroupRow(
                        stringResource(R.string.unpair), color = colors.danger,
                        onClick = { if (!leaving) confirming = true },
                    )
                }
            }
            Spacer(Modifier.height(16.dp))
            Group { GroupRow(stringResource(R.string.about), onClick = { model.pages.add(Page.About) }) }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.unpair_title)) },
            text = { Text(stringResource(R.string.unpair_message)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    leaving = true
                    model.go { model.unpair() }
                }) { Text(stringResource(R.string.unpair), color = colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/**
 * "About Yew": the lockup, version and build, what Yew is, the publisher and website,
 * then the privacy policy, terms and feedback.
 */
@Composable
fun AboutScreen(model: AppModel, close: () -> Unit) {
    val context = LocalContext.current
    Screen(stringResource(R.string.about), onBack = close) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Mascot(R.drawable.mascot_gift, 112.dp)
                Spacer(Modifier.height(12.dp))
                Lockup()
                Spacer(Modifier.height(10.dp))
                Text(
                    stringResource(R.string.about_version, BuildConfig.VERSION_NAME, BuildConfig.BUILD),
                    color = colors.soft, style = MaterialTheme.typography.bodySmall,
                )
            }
            // New versions: the release page on Gitee, and the daily check.
            var checks by remember { mutableStateOf(model.releases.enabled) }
            Group {
                model.newVersion?.let { version ->
                    GroupRow(stringResource(R.string.update_available, version), onClick = {
                        context.open(Intent(Intent.ACTION_VIEW, ReleaseCheck.page(version).toUri()))
                    })
                    GroupDivider()
                }
                GroupRow(
                    stringResource(R.string.update_daily),
                    stringResource(if (checks) R.string.update_daily_on else R.string.update_daily_off),
                )
                GroupDivider()
                GroupRow(
                    stringResource(if (checks) R.string.update_daily_turn_off else R.string.update_daily_turn_on),
                    onClick = {
                        checks = !checks
                        model.setReleaseChecks(checks)
                    },
                )
            }
            Spacer(Modifier.height(16.dp))
            Column(Modifier.padding(16.dp, 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.about_what))
                Text(stringResource(R.string.about_phone))
            }
            Spacer(Modifier.height(12.dp))
            Group {
                // The small horizontal publisher mark: the T at least 16dp, the name about 0.75 of
                // it, semibold, 0.3 of it apart.
                GroupRow(stringResource(R.string.publisher), leading = {
                    Image(painterResource(R.drawable.tenon_mark), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(18.dp * 0.3f))
                    Text(stringResource(R.string.tenon), fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                })
                GroupDivider()
                GroupRow(stringResource(R.string.website), stringResource(R.string.website_host), onClick = {
                    context.open(Intent(Intent.ACTION_VIEW, "https://tenonai.cn/".toUri()))
                })
            }
            Spacer(Modifier.height(16.dp))
            Group {
                GroupRow(stringResource(R.string.privacy_policy), onClick = { model.pages.add(Page.Policy(privacy = true)) })
                GroupDivider()
                GroupRow(stringResource(R.string.terms), onClick = { model.pages.add(Page.Policy(privacy = false)) })
                GroupDivider()
                GroupRow(stringResource(R.string.licenses), onClick = { model.pages.add(Page.Licenses) })
                GroupDivider()
                GroupRow(stringResource(R.string.feedback), stringResource(R.string.feedback_address), onClick = {
                    context.open(Intent(Intent.ACTION_SENDTO, "mailto:support@tenonai.cn".toUri()))
                })
            }
        }
    }
}

/** The privacy policy or the terms: the same text as Yew on the computer (src/shared/policy.ts). */
@Composable
fun PolicyScreen(privacy: Boolean, close: () -> Unit) {
    Screen(stringResource(if (privacy) R.string.privacy_policy else R.string.terms), onBack = close) { padding ->
        SelectionContainer {
            Column(
                Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    stringResource(R.string.policy_effective, stringResource(R.string.policy_version), stringResource(R.string.policy_date)),
                    color = colors.soft, style = MaterialTheme.typography.bodySmall,
                )
                for (paragraph in stringArrayResource(if (privacy) R.array.policy_privacy else R.array.policy_terms)) {
                    Text(paragraph)
                }
            }
        }
    }
}

/**
 * The open source libraries in the app, each license's text and the notices their packages carry.
 * The text is written by android/scripts/dependencies.ts from the libraries themselves.
 */
@Composable
fun LicensesScreen(close: () -> Unit) {
    val context = LocalContext.current
    val parts = remember {
        context.assets.open("licenses.txt").bufferedReader().use { it.readText() }.split("\n\n────────\n\n")
    }
    Screen(stringResource(R.string.licenses), onBack = close) { padding ->
        SelectionContainer {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                items(parts) { Text(it.trim(), style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
