package br.com.rota.entregas;

import android.os.Bundle;
import br.com.rota.entregas.tracking.RotaTrackingPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RotaTrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
