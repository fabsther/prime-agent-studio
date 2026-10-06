package dev.primeagent.fleet

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val vm: FleetViewModel by viewModels()
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33) permissions.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        else if (Build.VERSION.SDK_INT <= 28) permissions.launch(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE))
        setContent { FleetUi(vm) }
    }
    override fun onStart() { super.onStart(); vm.startPolling() }
    override fun onStop() { vm.stopPolling(); super.onStop() }
}
