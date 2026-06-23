package capsule

import "strconv"

func composeMicroVMTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	if manifest.PackageClass != executePackageClassMicroVMService {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be microvm-service"}
	}
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassMicroVMService); err != nil {
		return transientUnit{}, err
	}
	if len(manifest.Data.Volumes) > 0 || len(manifest.Data.Classes) > 0 {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: "microvm-service data volumes are not supported"}
	}

	unitName := capsuleUnitName(manifest.ID)
	limits := manifest.ResourceLimits
	properties := hardenedMicroVMTransientUnitProperties(manifest)
	properties = append(properties,
		systemdProperty{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
		systemdProperty{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
		systemdProperty{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
	)

	argv := []string{
		defaultNspawnPath,
		"--directory=" + ociRootDirectory(manifest),
		"--private-users=pick",
		"-U",
		"--as-pid2",
		"--ephemeral",
		"--private-network",
		"--drop-capability=all",
		"--",
	}
	argv = append(argv, manifest.Runtime.OCI.Image.Entrypoint...)

	return transientUnit{
		Name:       unitName,
		Argv:       argv,
		Properties: properties,
	}, nil
}

func hardenedMicroVMTransientUnitProperties(manifest ExecutionManifest) []systemdProperty {
	return []systemdProperty{
		{Name: "Description", Value: "Vita capsule " + manifest.ID + " microvm-service"},
		{Name: "Type", Value: "simple"},
		{Name: "NoNewPrivileges", Value: "yes"},
		{Name: "AmbientCapabilities", Value: ""},
		{Name: "ProtectSystem", Value: "strict"},
		{Name: "ProtectHome", Value: "yes"},
		{Name: "PrivateTmp", Value: "yes"},
		{Name: "PrivateDevices", Value: "yes"},
		{Name: "ProtectKernelTunables", Value: "yes"},
		{Name: "ProtectKernelModules", Value: "yes"},
		{Name: "ProtectKernelLogs", Value: "yes"},
		{Name: "ProtectClock", Value: "yes"},
		{Name: "RestrictSUIDSGID", Value: "yes"},
		{Name: "RestrictNamespaces", Value: "mnt pid ipc uts user net cgroup"},
		{Name: "RestrictRealtime", Value: "yes"},
		{Name: "RestrictAddressFamilies", Value: "AF_UNIX AF_NETLINK"},
		{Name: "LockPersonality", Value: "yes"},
		{Name: "SystemCallArchitectures", Value: "native"},
		{Name: "UMask", Value: "0077"},
	}
}
