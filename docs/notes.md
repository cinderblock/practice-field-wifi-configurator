# Useful commands

## Windows

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All

New-VMSwitch -name "VLAN-vSwitch" -NetAdapterName "Ethernet" -AllowManagementOS $true
Add-VMNetworkAdapter -ManagementOS -Name "VLAN-FMS" -SwitchName "VLAN-vSwitch" -Passthru | Set-VMNetworkAdapterVlan -Access -VlanId 4

Disable-NetAdapter -Name "vEthernet (VLAN-FMS)" -Confirm:$false
Enable-NetAdapter -Name "vEthernet (VLAN-FMS)"

ipconfig /release "vEthernet (VLAN-FMS)"
ipconfig /renew "vEthernet (VLAN-FMS)"

ping -t -S 192.168.69.214 192.168.69.1
ping -t -S 192.168.69.214 10.0.100.2
ping -t -S 10.255.0.215 192.168.69.1
ping -t -S 10.255.0.215 10.0.100.2
```
